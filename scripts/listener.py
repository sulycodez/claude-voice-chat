"""voice-chat listener: mic -> Whisper -> text, served to the Claude mod on localhost.

GET  /poll    -> {"texts": [...], "state": "listening|paused|loading", "level": 0..1}
POST /listen  -> resume listening      POST /pause -> stop listening
POST /quit    -> exit
Exits by itself if nobody polls for WATCHDOG_S seconds (mod unloaded / session closed).
"""
import argparse, json, queue, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sounddevice as sd

p = argparse.ArgumentParser()
p.add_argument("--port", type=int, default=47821)
p.add_argument("--model", default="base.en")
p.add_argument("--log", default=None)
args = p.parse_args()

RATE, FRAME = 16000, 480            # 30 ms frames
SILENCE_END_S, MIN_SPEECH_S, MAX_SPEECH_S = 0.9, 0.35, 30
WATCHDOG_S = 20
JUNK = {"", "you", "thank you", "thanks for watching", "bye", "uh", "um", "hmm", "."}

def log(*a):
    if args.log:
        with open(args.log, "a", encoding="utf-8") as f:
            print(time.strftime("%H:%M:%S"), *a, file=f)

lock = threading.Lock()
S = {"state": "loading", "texts": [], "level": 0.0, "last_poll": time.time(), "quit": False}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _ok(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        with lock:
            S["last_poll"] = time.time()
            body = {"texts": S["texts"], "state": S["state"], "level": round(S["level"], 3)}
            S["texts"] = []
        self._ok(body)
    def do_POST(self):
        with lock:
            S["last_poll"] = time.time()
            if self.path == "/listen" and S["state"] != "loading": S["state"] = "listening"
            elif self.path == "/pause" and S["state"] != "loading": S["state"] = "paused"
            elif self.path == "/quit": S["quit"] = True
            body = {"state": S["state"]}
        self._ok(body)

try:
    server = ThreadingHTTPServer(("127.0.0.1", args.port), H)
except OSError:
    log("port busy, another listener is running"); sys.exit(0)
threading.Thread(target=server.serve_forever, daemon=True).start()

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
    text = " ".join(s.text.strip() for s in segs if s.no_speech_prob < 0.6).strip()
    return "" if text.lower().strip(" .!?,") in JUNK else text

with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=FRAME, callback=cb):
    # calibrate noise floor
    floor_samples = [float(np.sqrt(np.mean(audio_q.get() ** 2))) for _ in range(30)]
    floor = max(float(np.median(floor_samples)), 0.002)
    threshold = max(floor * 3.0, 0.012)
    log(f"noise floor {floor:.4f} threshold {threshold:.4f}")
    with lock: S["state"] = "listening"

    speech, silent_frames, in_speech = [], 0, False
    pre = []  # short pre-roll so first syllable isn't cut
    while True:
        with lock:
            if S["quit"] or time.time() - S["last_poll"] > WATCHDOG_S: break
            listening = S["state"] == "listening"
        try:
            frame = audio_q.get(timeout=0.5)
        except queue.Empty:
            continue
        rms = float(np.sqrt(np.mean(frame ** 2)))
        with lock: S["level"] = min(1.0, rms / (threshold * 4))
        if not listening:
            speech, in_speech, pre = [], False, []
            continue
        loud = rms > threshold
        if not in_speech:
            pre = (pre + [frame])[-10:]
            if loud:
                in_speech, speech, silent_frames = True, list(pre), 0
            continue
        speech.append(frame)
        silent_frames = 0 if loud else silent_frames + 1
        dur = len(speech) * FRAME / RATE
        if silent_frames * FRAME / RATE >= SILENCE_END_S or dur >= MAX_SPEECH_S:
            in_speech = False
            if dur - silent_frames * FRAME / RATE < MIN_SPEECH_S:
                speech = []; continue
            buf = np.concatenate(speech); speech = []
            with lock: S["state"] = "transcribing"
            text = transcribe(buf)
            log("heard:", repr(text))
            with lock:
                if text:
                    S["texts"].append(text); S["state"] = "paused"   # mod resumes after the reply
                elif S["state"] == "transcribing":
                    S["state"] = "listening"

server.shutdown()
log("exit")
