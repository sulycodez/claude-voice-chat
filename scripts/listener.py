"""voice-chat listener: mic -> Whisper -> text, and replies read aloud, served to the Claude mod on localhost.

GET  /poll    -> {"texts": [...], "state": "loading|listening|transcribing|speaking|paused|error",
                  "level": 0..1, "error": "..."}
POST /listen  -> resume listening      POST /pause -> stop listening (and any speech)
POST /speak   -> body {"text", "voice"}: read it aloud, then listen. Talking over it interrupts.
POST /stop    -> stop speaking now and listen
POST /quit    -> exit
Exits by itself if nobody polls for --idle-exit seconds (the agent or session went away).
"""
import argparse, difflib, json, os, queue, re, subprocess, sys, tempfile, threading, time, traceback, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

p = argparse.ArgumentParser()
p.add_argument("--port", type=int, default=47821)
p.add_argument("--model", default="base.en")
p.add_argument("--log", default=None)
p.add_argument("--voice", default="", help="Piper voice to load at start, so the first reply is quick")
p.add_argument("--idle-exit", type=float, default=20, help="exit after this many seconds with nobody polling")
args = p.parse_args()

RATE, FRAME = 16000, 480            # 30 ms frames
SILENCE_END_S = 0.75                # this much quiet ends an utterance
HOLD_S = 0.5                        # then wait this long for more before sending, so a pause to think doesn't cut you off
MIN_SPEECH_S, MAX_SPEECH_S = 0.35, 30
PRE_ROLL = 20                       # frames (0.6 s) kept from before speech starts, so the first word isn't clipped
MIN_THRESHOLD = 0.005               # quiet laptop mics sit far below the old 0.012
MAX_THRESHOLD = 0.04                # so a noisy start can never make a normal voice too quiet to hear
FLOOR_WINDOW = 330                  # frames (10 s) the noise floor is re-measured over, all the time
NO_AUDIO_S = 3                      # no frames from the mic this long means it was unplugged or taken
VERSION = 7                         # the mod replaces a listener that reports another version
JUNK = {"", "you", "thank you", "thanks for watching", "bye", "uh", "um", "hmm", "."}
# Talking over a reply: your voice has to beat the reply's own echo by this much, for this long.
BARGE_RATIO, BARGE_FRAMES, BARGE_WINDOW = 3.0, 6, 12  # loud in 6 of any 12 frames (360 ms): a short "stop" counts, a click doesn't
# Windows' echo cancelling takes about a second to lock on at the start of each reply, and lets
# the reply through loudly until then (measured on a laptop mic array), so no interrupting
# in that first stretch.
BARGE_GRACE_S = 1.5
STOP_WORDS = {"stop", "stop it", "stop stop", "okay stop", "ok stop", "shut up", "skip", "skip it",
              "enough", "that's enough", "quiet", "be quiet", "cancel", "never mind", "nevermind"}

def log(*a):
    if args.log:
        with open(args.log, "a", encoding="utf-8") as f:
            print(time.strftime("%H:%M:%S"), *a, file=f)

lock = threading.Lock()
S = {"state": "loading", "texts": [], "level": 0.0, "last_poll": time.time(), "quit": False, "error": ""}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _ok(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        with lock:
            S["last_poll"] = time.time()
            body = {"texts": S["texts"], "state": S["state"], "level": round(S["level"], 3), "error": S["error"],
                    "version": VERSION}
            S["texts"] = []
        self._ok(body)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except ValueError:
            data = {}
        speak = None
        with lock:
            S["last_poll"] = time.time()
            busy = S["state"] in ("loading", "error")
            if self.path == "/listen" and not busy: S["state"] = "listening"
            elif self.path == "/pause" and not busy: S["state"] = "paused"
            elif self.path == "/stop" and not busy: S["state"] = "listening"
            elif self.path == "/speak" and not busy and str(data.get("text", "")).strip():
                S["state"] = "speaking"; speak = (str(data["text"]), str(data.get("voice", "")))
            elif self.path == "/speak" and not busy: S["state"] = "listening"
            elif self.path == "/quit": S["quit"] = True
            body = {"state": S["state"]}
        if SPEAKER:
            if speak: SPEAKER.speak(*speak)
            elif self.path in ("/pause", "/stop", "/listen", "/quit"): SPEAKER.stop()
        self._ok(body)

SPEAKER = None

def is_echo(heard, said):
    """Was this our own reply coming back through the mic? Whisper garbles it a bit, so
    compare words: nearly all of them in the reply, or most of them with a run of three
    in a row. Someone cutting in says words the reply doesn't."""
    h = re.findall(r"[a-z0-9']+", heard.lower()); sw = re.findall(r"[a-z0-9']+", said.lower())
    if not h or not sw: return False
    s_set = set(sw)
    near = lambda w: w in s_set or (len(w) >= 4 and difflib.get_close_matches(w, s_set, n=1, cutoff=0.8))
    hit = sum(bool(near(w)) for w in h) / len(h)
    if len(h) <= 2: return hit == 1.0
    if hit >= 0.75: return True
    said_txt = " " + " ".join(sw) + " "
    run3 = any(" " + " ".join(h[i:i + 3]) + " " in said_txt for i in range(len(h) - 2))
    return hit >= 0.5 and run3

def fit_echo(np, mic_hist, ref):
    """Does the mic follow the reply? Correlate the mic's level with the reply's level at
    each delay up to 0.9 s. A mic with no echo cancelling follows it closely, and then the
    echo's delay and size are measured. With echo cancelling (most laptop mics) only short
    random spikes leak, which don't follow the reply: returns "none"."""
    if len(mic_hist) < 33 or len(ref) < 30: return None
    mt = np.array([t for t, _ in mic_hist]); mr = np.array([r for _, r in mic_hist])
    rt = np.array([t for t, _ in ref]); rr = np.array([r for _, r in ref])
    lm = np.log(mr + 1e-4)
    best_c, best_lag = -1.0, 0.0
    for lag in np.arange(0.0, 0.9, 0.03):
        x = np.interp(mt - lag, rt, rr, left=0.0, right=0.0)
        if x.std() < 1e-4: continue
        c = float(np.corrcoef(lm, np.log(x + 1e-4))[0, 1])
        if c > best_c: best_c, best_lag = c, float(lag)
    if best_c < 0.5: return "none"
    x = np.interp(mt - best_lag, rt, rr, left=0.0, right=0.0); act = x > 0.003
    if act.sum() < 15: return None
    return (best_lag, min(max(float(np.median(mr[act] / x[act])), 0.01), 2.0), best_c)

VOICE_DIR = os.environ.get("VOICE_CHAT_VOICES") or os.path.join(os.path.expanduser("~"), ".cache", "voice-chat", "voices")
FALLBACK_VOICE = "Microsoft Hazel Desktop"
_piper = {}

def fetch_voice(name):
    """Download a missing Piper voice (about 63 MB, once) from the Piper project on Hugging
    Face, then use it from the next reply. Until then the Windows voice speaks."""
    onnx = os.path.join(VOICE_DIR, name + ".onnx")
    if not name or name.startswith("Microsoft") or (os.path.exists(onnx) and os.path.exists(onnx + ".json")): return
    try:
        import urllib.request
        region, quality, speaker = name.split("-")[0], name.split("-")[-1], "-".join(name.split("-")[1:-1])
        base = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{region.split('_')[0]}/{region}/{speaker}/{quality}/{name}"
        os.makedirs(VOICE_DIR, exist_ok=True)
        log(f"downloading voice {name}")
        for suffix in (".onnx.json", ".onnx"):
            dest = os.path.join(VOICE_DIR, name + suffix); part = dest + ".part"
            with urllib.request.urlopen(base + suffix, timeout=30) as r, open(part, "wb") as f:
                while True:
                    block = r.read(1 << 20)
                    if not block: break
                    f.write(block)
            os.replace(part, dest)
        _piper.pop(name, None)   # pick it up on the next reply
        log(f"voice {name} ready")
    except Exception as e:
        log(f"could not download voice {name}: {e!r}")

def piper_voice(name):
    """A Piper neural voice (natural sounding, runs offline) if it is installed and
    downloaded, else None and the Windows voice is used instead."""
    if not name or name.startswith("Microsoft"): return None
    if name not in _piper:
        path = os.path.join(VOICE_DIR, name + ".onnx")
        try:
            from piper import PiperVoice
            _piper[name] = PiperVoice.load(path) if os.path.exists(path) else None
            if _piper[name] is None: log(f"voice {name} not downloaded, using the Windows voice")
        except Exception as e:
            log("Piper unavailable, using the Windows voice:", repr(e)); _piper[name] = None
    return _piper[name]

def synth(text, voice, np):
    """The reply as float samples and their rate: Piper if it is set up, else Windows' own voice."""
    v = piper_voice(voice)
    if v is not None:
        chunks = list(v.synthesize(text))
        if not chunks: return np.zeros(0, dtype="float32"), RATE
        return np.concatenate([c.audio_float_array for c in chunks]).astype("float32"), chunks[0].sample_rate
    if not voice.startswith("Microsoft"): voice = FALLBACK_VOICE
    fd, path = tempfile.mkstemp(suffix=".wav"); os.close(fd)
    q = lambda v: v.replace("'", "''")
    ps = ("[Console]::InputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech; "
          "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
          "try { $s.SelectVoice('" + q(voice) + "') } catch {}; $s.Rate = 1; "
          "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, "
          "[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); "
          "$s.SetOutputToWaveFile('" + q(path) + "', $f); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()")
    try:
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], input=text.encode("utf-8"),
                       capture_output=True, timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        with wave.open(path) as w:
            return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype("float32") / 32768, RATE
    finally:
        try: os.remove(path)
        except OSError: pass

class Speaker:
    """Plays replies and remembers how loud each 30 ms of it was, so the mic loop can
    tell the reply's echo from you talking over it."""
    def __init__(self, np, sd):
        self.np, self.sd = np, sd
        self.mx = threading.Lock()
        self.gen, self.stream, self.ref = 0, None, []
        self.audible_since = None   # when the reply first made a sound
        self.play = None            # the reply playing now: its place, so a false alarm can carry on
        self.text = ""              # what it is saying
        self.last = ("", 0.0)       # what it said last, and when it ended

    def speak(self, text, voice):
        gen = self.stop()
        self.text = text
        threading.Thread(target=self._play, args=(text, voice, gen), daemon=True).start()

    def stop(self):
        with self.mx:
            self.gen += 1; st, self.stream = self.stream, None
            if self.play is not None: self.last = (self.text, time.time())
            self.play = None
        if st is not None:
            try: st.abort(); st.close()
            except Exception: pass
        return self.gen

    def pause(self):
        """Go quiet but keep the place, in case what interrupted was only our own echo."""
        with self.mx:
            st, self.stream = self.stream, None
            if self.play is not None: self.play["paused"] = True
        if st is not None:
            try: st.abort(); st.close()
            except Exception: pass

    def resume(self):
        """Carry on from half a second before the pause. False if there is nothing to resume."""
        with self.mx:
            p = self.play
            if p is None or not p["paused"]: return False
            p["paused"] = False
            p["pos"][0] = max(0, p["pos"][0] - p["sr"] // 2)
            self.audible_since = None   # echo cancelling settles again after a restart
            self.stream = self.sd.OutputStream(samplerate=p["sr"], channels=1, dtype="float32", blocksize=FRAME,
                                               callback=p["cb"], finished_callback=p["fin"])
            self.stream.start()
        return True

    def _play(self, text, voice, gen):
        np, sd = self.np, self.sd
        t0 = time.time()
        # Render a sentence or two at a time and start playing after the first, so a
        # long reply starts as fast as a short one; the rest renders while it plays.
        pieces, cur = [], ""
        for part in re.split(r"(?<=[.!?])\s+", text.strip()):
            cur = (cur + " " + part).strip()
            if len(cur) >= (80 if not pieces else 240):
                pieces.append(cur); cur = ""
        if cur: pieces.append(cur)
        def render(piece):
            try:
                return synth(piece, voice, np)
            except Exception as e:
                log("speech failed:", repr(e)); return np.zeros(0, dtype="float32"), RATE
        first, sr = render(pieces[0]) if pieces else (np.zeros(0, dtype="float32"), RATE)
        buf = {"a": first, "done": len(pieces) <= 1}
        log(f"speaking, first part {len(first) / sr:.1f}s rendered in {time.time() - t0:.1f}s, {len(pieces)} parts")
        def render_rest():
            for piece in pieces[1:]:
                if self.gen != gen: return
                buf["a"] = np.concatenate([buf["a"], render(piece)[0]])
            buf["done"] = True
        threading.Thread(target=render_rest, daemon=True).start()
        audio = buf["a"]
        pos, ref = [0], []
        self.audible_since = None
        def cb(outdata, frames, t, status):
            a = buf["a"]
            chunk = a[pos[0]:pos[0] + frames]
            pos[0] += len(chunk)          # a gap while the next part renders plays as silence
            outdata[:len(chunk), 0] = chunk
            outdata[len(chunk):, 0] = 0
            r = float(np.sqrt(np.mean(chunk ** 2))) if len(chunk) else 0.0
            ref.append((time.time(), r))
            if r > 0.003 and self.audible_since is None: self.audible_since = time.time()
            if len(ref) > 200: del ref[0]
            if buf["done"] and pos[0] >= len(buf["a"]): raise sd.CallbackStop()
        play = {"pos": pos, "paused": False, "sr": sr}
        def finished():
            with self.mx:
                if self.gen != gen or play["paused"]: return
                self.stream, self.play = None, None
                self.last = (text, time.time())
            with lock:
                if S["state"] == "speaking": S["state"] = "listening"
            log("spoke to the end")
        play["cb"], play["fin"] = cb, finished
        with self.mx:
            if self.gen != gen: return
            if not len(audio) and buf["done"]:
                with lock:
                    if S["state"] == "speaking": S["state"] = "listening"
                return
            self.ref, self.play = ref, play
            self.stream = sd.OutputStream(samplerate=sr, channels=1, dtype="float32", blocksize=FRAME,
                                          callback=cb, finished_callback=finished)
            self.stream.start()

    def echo(self, now, lag):
        """How loud the reply was when the sound now reaching the mic left the speaker."""
        return max((r for t, r in self.ref[-40:] if abs(now - lag - t) <= 0.075), default=0.0)

def should_stop():
    with lock:
        return S["quit"] or time.time() - S["last_poll"] > args.idle_exit

def run():
    import numpy as np
    import sounddevice as sd

    log("loading model", args.model)
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    log("model ready")
    global SPEAKER
    SPEAKER = Speaker(np, sd)
    if args.voice:
        def warm(name):
            fetch_voice(name); piper_voice(name)   # download if missing, then load, so replies start fast
        threading.Thread(target=warm, args=(args.voice,), daemon=True).start()

    audio_q: "queue.Queue[np.ndarray]" = queue.Queue()
    def cb(indata, frames, t, status):
        audio_q.put(indata[:, 0].copy())

    def transcribe(buf: np.ndarray) -> str:
        segs, _ = model.transcribe(buf, language="en", beam_size=3, vad_filter=True,
                                   condition_on_previous_text=False)
        # Drop what Whisper itself doubts: background noise turned into words.
        text = " ".join(s.text.strip() for s in segs
                        if s.no_speech_prob < 0.6 and s.avg_logprob > -1.0 and s.compression_ratio < 2.4).strip()
        return "" if text.lower().strip(" .!?,") in JUNK else text

    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=FRAME, callback=cb):
        # Noise floor: the quiet end (20th percentile) of recent frames, so someone
        # already talking when the mic opens doesn't set it, and it keeps up with
        # a fan or a TV that starts later.
        calib = [audio_q.get(timeout=5) for _ in range(30)]
        recent = [float(np.sqrt(np.mean(f ** 2))) for f in calib]
        def levels():
            floor = max(float(np.percentile(recent, 20)), 0.0005)
            thr = min(max(floor * 4.0, MIN_THRESHOLD), MAX_THRESHOLD)
            return floor, thr, thr * 0.6   # hysteresis: once talking, softer sounds still count
        floor, threshold, quiet = levels()
        log(f"noise floor {floor:.4f} threshold {threshold:.4f}")
        with lock: S["state"] = "listening"
        last_frame, n = time.time(), 0

        speech, silent_frames, in_speech = [], 0, False
        pre = calib[-PRE_ROLL:]     # pre-roll so the first syllable isn't cut (and words said while calibrating count)
        pending, send_at = [], 0.0  # finished utterances waiting out HOLD_S in case you carry on
        # Talking over a reply. echo_model: what reaches the mic from the speaker. None until
        # measured, "none" when echo cancelling removes it, or (delay, size, fit). It is kept
        # only from replies nobody talked over, so your voice is never learned as echo.
        loud, barged, echo_model, mic_hist, reply_model, reply_barged = [], False, None, [], None, False
        strict = 1.0   # raised each time our own voice set it off, so it doesn't keep stuttering
        margins = []
        while not should_stop():
            with lock:
                state = S["state"]
                listening = state in ("listening", "transcribing")
            if pending and not in_speech and time.time() >= send_at:
                text = " ".join(pending); pending = []
                log("sent:", repr(text))
                with lock:
                    if S["state"] in ("listening", "transcribing"):
                        S["texts"].append(text); S["state"] = "paused"   # mod resumes after the reply
                continue
            try:
                frame = audio_q.get(timeout=0.2)
            except queue.Empty:
                if time.time() - last_frame > NO_AUDIO_S:
                    raise RuntimeError("the microphone stopped sending audio (unplugged, or another app took it)")
                continue
            last_frame = time.time()
            rms = float(np.sqrt(np.mean(frame ** 2)))
            recent.append(rms); n += 1
            if len(recent) > FLOOR_WINDOW: del recent[0]
            if n % 33 == 0:
                new = levels()
                if abs(new[1] - threshold) > threshold * 0.25: log(f"noise floor {new[0]:.4f} threshold {new[1]:.4f}")
                floor, threshold, quiet = new
            with lock: S["level"] = min(1.0, rms / (threshold * 4))
            if state == "speaking":
                speech, in_speech, pending = [], False, []
                pre = (pre + [frame])[-100:]   # 3 s, so cutting in late still keeps your first words
                now = time.time()
                since = SPEAKER.audible_since if SPEAKER else None
                if since is None or now - since < BARGE_GRACE_S:
                    loud = []
                    continue
                mic_hist = (mic_hist + [(now, rms)])[-130:]
                if n % 11 == 0 and echo_model is None:
                    # Nothing kept from an earlier reply: measure on this one (your voice
                    # doesn't follow the reply either, so it can't pass for echo here).
                    reply_model = fit_echo(np, mic_hist, SPEAKER.ref) or reply_model
                use = echo_model if echo_model is not None else reply_model
                if use is None:
                    loud = []      # first reply, not measured yet (about 2 s in)
                    continue
                if use == "none":
                    bar, e = threshold * 3, 0.0
                else:
                    e = SPEAKER.echo(now, use[0])
                    # A tight fit means the echo estimate is precise, so a smaller margin is safe.
                    bar = max(threshold * 3, (2.0 if use[2] >= 0.8 else BARGE_RATIO) * use[1] * e + threshold)
                bar *= strict
                margins.append(rms / bar)
                loud = (loud + [rms > bar])[-BARGE_WINDOW:]
                if sum(loud) >= BARGE_FRAMES:
                    log(f"talked over the reply? (mic {rms:.3f}, bar {bar:.3f}, echo model {use if use == 'none' else tuple(round(v, 3) for v in use)})")
                    SPEAKER.pause()   # quiet, but keep the place until we know it was you
                    with lock:
                        if S["state"] == "speaking": S["state"] = "transcribing"
                    # Rewind to where you started: back to the last half second of quiet.
                    start, q = len(pre), 0
                    for i in range(len(pre) - 1, -1, -1):
                        q = q + 1 if float(np.sqrt(np.mean(pre[i] ** 2))) < threshold * 2 else 0
                        if q >= 17: break
                        start = i
                    in_speech, speech, silent_frames, barged, loud, reply_barged = True, pre[max(start - 5, 0):], 0, True, [], True
                continue
            if margins:
                m = sorted(margins)
                if not reply_barged and m[int(len(m) * 0.9)] < 0.5:
                    # Played to the end with nobody near the interrupt bar: the cleanest measure. Keep it.
                    fitted = fit_echo(np, mic_hist, SPEAKER.ref) if SPEAKER else None
                    if fitted is not None: echo_model = fitted
                log(f"loudest echo vs interrupt bar: p50 {m[len(m) // 2]:.2f} p99 {m[int(len(m) * 0.99)]:.2f} "
                    f"max {m[-1]:.2f} (1.0 interrupts); echo model {echo_model if not isinstance(echo_model, tuple) else tuple(round(v, 3) for v in echo_model)}")
                margins = []
                strict = max(1.0, strict * 0.85)
            loud, mic_hist, reply_model, reply_barged = [], [], None, False
            if not listening:
                speech, in_speech, pre, pending = [], False, [], []
                continue
            if not in_speech:
                pre = (pre + [frame])[-PRE_ROLL:]
                if rms > threshold:
                    in_speech, speech, silent_frames = True, list(pre), 0
                    if pending:
                        with lock: S["state"] = "transcribing"   # still hearing you
                continue
            speech.append(frame)
            silent_frames = 0 if rms > quiet else silent_frames + 1
            dur = len(speech) * FRAME / RATE
            if silent_frames * FRAME / RATE >= SILENCE_END_S or dur >= MAX_SPEECH_S:
                in_speech = False
                if dur - silent_frames * FRAME / RATE < MIN_SPEECH_S:
                    speech = []
                    if not pending:
                        with lock:
                            if S["state"] == "transcribing": S["state"] = "listening"
                    continue
                buf = np.concatenate(speech); speech = []
                with lock: S["state"] = "transcribing"
                text = transcribe(buf)
                log("heard:", repr(text))
                if barged:
                    barged = False
                    if not text or is_echo(text, SPEAKER.text):
                        # Our own voice (or a noise), not you: carry on, and be harder to set off.
                        strict = min(strict * 2, 8.0)
                        log(f"that was my own voice or a noise, carrying on (now {strict:.0f}x stricter)")
                        resumed = SPEAKER.resume()
                        with lock:
                            if S["state"] == "transcribing": S["state"] = "speaking" if resumed else "listening"
                        continue
                    SPEAKER.stop()
                    if text.lower().strip(" .!?,") in STOP_WORDS:
                        text = ""   # "stop" just stops the reply
                elif text and SPEAKER and time.time() - SPEAKER.last[1] < 4 and is_echo(text, SPEAKER.last[0]):
                    log("that was the end of my own reply echoing, ignored")
                    text = ""
                if text:
                    pending.append(text); send_at = time.time() + HOLD_S
                elif not pending:
                    with lock:
                        if S["state"] == "transcribing": S["state"] = "listening"

class Server(ThreadingHTTPServer):
    # Windows lets a second socket share a port with SO_REUSEADDR, which would
    # leave two listeners fighting over the mic. Claim the port alone instead.
    allow_reuse_address = False
    def server_bind(self):
        import socket
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

try:
    server = Server(("127.0.0.1", args.port), H)
except OSError:
    log("port busy, another listener is running"); sys.exit(0)
threading.Thread(target=server.serve_forever, daemon=True).start()

try:
    run()
except Exception as e:
    # Keep serving long enough for the mod to show what went wrong.
    log("failed:\n" + traceback.format_exc())
    msg = f"{type(e).__name__}: {e}"
    if isinstance(e, ImportError):
        msg += " (run: pip install faster-whisper sounddevice numpy)"
    with lock: S["state"], S["error"] = "error", msg[:200]
    while not should_stop():
        time.sleep(0.5)

server.shutdown()
log("exit")
