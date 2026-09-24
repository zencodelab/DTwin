"""Narration -> one WAV per line, and a report of each line's length.

    python3 gen_audio.py [rate]      (default 165, Samantha — as the Markaba video)
"""
import os, subprocess, sys, wave, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from narration import LINES
RATE = int(sys.argv[1]) if len(sys.argv) > 1 else 165
os.makedirs(f"{HERE}/audio", exist_ok=True)
durs = {}
for sid, text in LINES:
    out = f"{HERE}/audio/{sid}.wav"
    subprocess.run(["say", "-v", "Samantha", "-r", str(RATE), "-o", out,
                    "--file-format=WAVE", "--data-format=LEI16@44100", text], check=True)
    with wave.open(out) as w:
        durs[sid] = round(w.getnframes() / w.getframerate(), 3)
    print(f"{sid:5} {durs[sid]:6.2f}s  {len(text.split()):3} words")
json.dump(durs, open(f"{HERE}/audio/durations.json", "w"), indent=1)
print(f"total speech {sum(durs.values()):.1f}s")
