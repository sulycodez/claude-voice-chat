"""voice-chat listener: mic -> Whisper -> text, served to the Claude mod on localhost.

GET  /poll    -> {"texts": [...], "state": "loading|listening|transcribing|paused|error",
                  "level": 0..1, "error": "..."}
POST /listen  -> resume listening      POST /pause -> stop listening
POST /quit    -> exit
Exits by itself if nobody polls for WATCHDOG_S seconds (mod unloaded / session closed).
"""
import argparse, json, queue, sys, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

p = argparse.ArgumentParser()
p.add_argument("--port", type=int, default=47821)
p.add_argument("--model", default="base.en")
p.add_argument("--log", default=None)
args = p.parse_args()

RATE, FRAME = 16000, 480            # 30 ms frames
SILENCE_END_S = 0.9                 # this much quiet ends an utterance
HOLD_S = 0.7                        # then wait this long for more before sending, so a pause to think doesn't cut you off
MIN_SPEECH_S, MAX_SPEECH_S = 0.35, 30
PRE_ROLL = 20                       # frames (0.6 s) kept from before speech starts, so the first word isn't clipped
MIN_THRESHOLD = 0.005               # quiet laptop mics sit far below the old 0.012
MAX_THRESHOLD = 0.04                # so a noisy start can never make a normal voice too quiet to hear
FLOOR_WINDOW = 330                  # frames (10 s) the noise floor is re-measured over, all the time
NO_AUDIO_S = 3                      # no frames from the mic this long means it was unplugged or taken
WATCHDOG_S = 20
JUNK = {"", "you", "thank you", "thanks for watching", "bye", "uh", "um", "hmm", "."}

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
            body = {"texts": S["texts"], "state": S["state"], "level": round(S["level"], 3), "error": S["error"]}
            S["texts"] = []
        self._ok(body)
    def do_POST(self):
        with lock:
            S["last_poll"] = time.time()
            busy = S["state"] in ("loading", "error")
            if self.path == "/listen" and not busy: S["state"] = "listening"
            elif self.path == "/pause" and not busy: S["state"] = "paused"
            elif self.path == "/quit": S["quit"] = True
            body = {"state": S["state"]}
        self._ok(body)

def should_stop():
    with lock:
        return S["quit"] or time.time() - S["last_poll"] > WATCHDOG_S

def run():
    import numpy as np
    import sounddevice as sd

    log("loading model", args.model)
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    log("model ready")

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
        while not should_stop():
            with lock:
                listening = S["state"] in ("listening", "transcribing")
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
