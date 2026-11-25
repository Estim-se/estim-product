"""estim Samtal: local speech to text with KB-Whisper (KBLab) through faster-whisper, free and offline after the first
model download. Used by scripts/samtal-local.ts until a Berget key exists; production uses Berget (stt.server.ts).

Prints one JSON object per input file on its own line, in the same shape as an OpenAI-compatible verbose_json answer
(segments with start, end and text), so the same transcript reader is used. No speaker labels locally (faster-whisper
has no diarisation); the interpretation does not depend on them.

Usage: python samtal-whisper.py [--model small] [--compute int8] [--threads 0] FILE...
Install once:  python -m venv venv && venv\\Scripts\\pip install faster-whisper==1.1.1 requests
"""
import argparse
import json
import sys
import time

from faster_whisper import WhisperModel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small", choices=["tiny", "base", "small", "medium", "large"])
    parser.add_argument("--compute", default="int8", help="int8 on CPU; float16 on an Nvidia GPU")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=0, help="0 = all cores")
    parser.add_argument("--cache", default=None, help="model download folder (default: Hugging Face cache)")
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()

    model_id = f"KBLab/kb-whisper-{args.model}"
    loaded = time.time()
    model = WhisperModel(model_id, device=args.device, compute_type=args.compute, cpu_threads=args.threads, download_root=args.cache)
    load_seconds = time.time() - loaded
    for path in args.files:
        started = time.time()
        try:
            # condition_on_previous_text=False is KBLab's advice against hallucinations without prompts.
            segments, info = model.transcribe(path, language="sv", beam_size=5, vad_filter=True, condition_on_previous_text=False)
            out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
            print(json.dumps({"file": path, "model": model_id, "language": info.language, "duration": round(info.duration, 2),
                              "seconds": round(time.time() - started, 2), "load_seconds": round(load_seconds, 2), "segments": out}, ensure_ascii=False), flush=True)
        except Exception as error:  # one failing file never stops the others; no content in the error line
            print(json.dumps({"file": path, "error": type(error).__name__}), flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
