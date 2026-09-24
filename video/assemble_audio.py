"""Per-line WAVs -> one narration track, each line at its start from timeline.json."""
import json, os, wave
HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(f"{HERE}/timeline.json"))
RATE, WIDTH, CH = 44100, 2, 1
buf = bytearray(int(TL["total"] * RATE) * WIDTH * CH)          # silence
placed = []
for sid, ln in TL["lines"].items():
    with wave.open(f"{HERE}/audio/{sid}.wav") as w:
        assert (w.getframerate(), w.getsampwidth(), w.getnchannels()) == (RATE, WIDTH, CH), sid
        data = w.readframes(w.getnframes())
    off = int(ln["start"] * RATE) * WIDTH * CH
    end = off + len(data)
    assert end <= len(buf), f"{sid} runs past the picture"
    for ps, pe, psid in placed:                                  # never mix two lines
        assert end <= ps or off >= pe, f"{sid} overlaps {psid}"
    buf[off:end] = data
    placed.append((off, end, sid))
out = f"{HERE}/audio/narration.wav"
with wave.open(out, "wb") as w:
    w.setnchannels(CH); w.setsampwidth(WIDTH); w.setframerate(RATE); w.writeframes(bytes(buf))
speech = sum(pe - ps for ps, pe, _ in placed) / (RATE * WIDTH * CH)
print(f"wrote {out}: {len(buf) / (RATE * WIDTH * CH):.2f}s, speech {speech:.1f}s, {len(placed)} clips, no overlaps")
