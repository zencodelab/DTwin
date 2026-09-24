"""A cut's narration track and captions, from the full timeline + cut.json.

The picture is re-rendered by render_cut.js, which photographs only the chosen
windows of the intact timeline. This does the same arithmetic for the sound and
the text: a line kept by a window moves to `t - window.start + window.newStart`,
and anything outside every window is dropped.

Nothing here re-synthesises speech — the per-line WAVs in audio/ and the cues in
the full .srt are reused verbatim, so the cut cannot drift from what was said.
"""
import json, os, re, wave

HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(f"{HERE}/timeline.json"))
PLAN = json.load(open(f"{HERE}/cut.json"))
NAME = PLAN["name"]
RATE, WIDTH, CH = 44100, 2, 1

# --- window map: (src_start, src_end, new_start) ---------------------------
WINDOWS, acc = [], 0.0
for a, b in PLAN["windows"]:
    WINDOWS.append((a, b, acc))
    acc += b - a
TOTAL = acc
print(f"{len(WINDOWS)} window(s) -> {TOTAL:.2f}s  (source {TL['total']:.2f}s)")

def remap(t):
    """Source time -> cut time, or None if this instant is not in the cut."""
    for a, b, new in WINDOWS:
        if a <= t < b:
            return t - a + new
    return None

# --- narration ------------------------------------------------------------
buf = bytearray(int(TOTAL * RATE) * WIDTH * CH)
kept, dropped, placed = [], [], []
for sid, ln in sorted(TL["lines"].items(), key=lambda kv: kv[1]["start"]):
    new = remap(ln["start"])
    if new is None:
        dropped.append(sid); continue
    with wave.open(f"{HERE}/audio/{sid}.wav") as w:
        assert (w.getframerate(), w.getsampwidth(), w.getnchannels()) == (RATE, WIDTH, CH), sid
        data = w.readframes(w.getnframes())
    off = int(new * RATE) * WIDTH * CH
    end = off + len(data)
    assert end <= len(buf), f"{sid} runs past the cut — a window ends mid-line"
    for ps, pe, psid in placed:
        assert end <= ps or off >= pe, f"{sid} overlaps {psid}"
    buf[off:end] = data
    placed.append((off, end, sid)); kept.append(sid)

out_wav = f"{HERE}/audio/narration-{NAME}.wav"
with wave.open(out_wav, "wb") as w:
    w.setnchannels(CH); w.setsampwidth(WIDTH); w.setframerate(RATE); w.writeframes(bytes(buf))
speech = sum(pe - ps for ps, pe, _ in placed) / (RATE * WIDTH * CH)
print(f"audio: {out_wav}  {TOTAL:.2f}s, speech {speech:.1f}s")
print(f"  kept    {' '.join(kept)}")
print(f"  dropped {' '.join(dropped)}")

# --- captions -------------------------------------------------------------
def parse_ts(s):
    h, m, rest = s.split(":"); sec, ms = rest.replace(".", ",").split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000

def fmt(t, sep=","):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"

src = open(f"{HERE}/dtwin-copilot.srt", encoding="utf-8").read().strip()
cues, out = re.split(r"\n\s*\n", src), []
for block in cues:
    lines = block.strip().splitlines()
    if len(lines) < 3: continue
    m = re.match(r"(\S+)\s*-->\s*(\S+)", lines[1])
    if not m: continue
    a, b = parse_ts(m.group(1)), parse_ts(m.group(2))
    na = remap(a)
    if na is None: continue
    # clamp: a cue may run past its window's end
    win = next(w for w in WINDOWS if w[0] <= a < w[1])
    nb = min(b, win[1]) - win[0] + win[2]
    if nb - na < 0.15: continue
    out.append((na, nb, "\n".join(lines[2:])))

with open(f"{HERE}/dtwin-copilot-{NAME}.srt", "w", encoding="utf-8") as f:
    for i, (a, b, txt) in enumerate(out, 1):
        f.write(f"{i}\n{fmt(a)} --> {fmt(b)}\n{txt}\n\n")
with open(f"{HERE}/dtwin-copilot-{NAME}.vtt", "w", encoding="utf-8") as f:
    f.write("WEBVTT\n\n")
    for a, b, txt in out:
        f.write(f"{fmt(a,'.')} --> {fmt(b,'.')}\n{txt}\n\n")
print(f"captions: {len(out)} cues kept of {len(cues)} -> dtwin-copilot-{NAME}.srt / .vtt")
