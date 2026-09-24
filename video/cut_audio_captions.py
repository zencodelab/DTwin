"""A cut's narration track and captions, from the full timeline + cut.json.

The picture is re-rendered by render_cut.js, which photographs only the chosen
windows of the intact timeline. This does the same arithmetic for the sound and
the text: a line kept by a window moves to `t - window.start + window.newStart`,
and anything outside every window is dropped.

Nothing here re-synthesises speech — the per-line WAVs in audio/ and the cues in
the full .srt are reused verbatim, so the cut cannot drift from what was said.
"""
import json, os, re, sys, wave

HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(f"{HERE}/timeline.json"))
PLAN = json.load(open(sys.argv[1] if len(sys.argv) > 1 else f"{HERE}/cut.json"))
NAME = PLAN["name"]
RATE, WIDTH, CH = 44100, 2, 1

# --- window map: (src_start, src_end, new_start, speed) --------------------
# A window is [start, end] or [start, end, speed]; speed > 1 plays that stretch
# faster. Must match render_cut.js exactly, which reads the same plan.
# Either form: [start, end, speed?] or {start, end, speed?, captions?}.
#   captions omitted -> keep the .srt's cues that fall in the window
#   captions False   -> none in that window
#   captions [[srcStart, srcEnd, text], ...] -> replace them (source times, remapped like any cue)
# The replace form exists for sped-up windows: eight cues at 2x are an unreadable
# flicker, but one caption held for the whole card is not.
def _norm(w):
    if isinstance(w, list):
        return {"start": w[0], "end": w[1], "speed": w[2] if len(w) > 2 else 1.0, "captions": None}
    return {"speed": 1.0, "captions": None, **w}
WINDOWS, acc = [], 0.0
for w in map(_norm, PLAN["windows"]):
    WINDOWS.append((w["start"], w["end"], acc, w["speed"], w["captions"]))
    acc += (w["end"] - w["start"]) / w["speed"]
TOTAL = acc
SPED_UP = any(win[3] != 1 for win in WINDOWS)
print(f"{len(WINDOWS)} window(s) -> {TOTAL:.2f}s  (source {TL['total']:.2f}s)"
      + ("  [some windows sped up]" if SPED_UP else ""))

def remap(t):
    """Source time -> cut time, or None if this instant is not in the cut."""
    for a, b, new, sp, _ in WINDOWS:
        if a <= t < b:
            return (t - a) / sp + new
    return None

def window_of(t):
    return next((w for w in WINDOWS if w[0] <= t < w[1]), None)

# --- narration ------------------------------------------------------------
def write_audio():
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

if SPED_UP:
    # The per-line WAVs cannot be time-stretched here, and placing them
    # unstretched into a faster window would overlap the next line. A sped-up
    # plan is for a silent render; say so rather than write a wrong track.
    print("audio: SKIPPED — a window is sped up, so this plan is silent-only")
else:
    write_audio()

# --- captions -------------------------------------------------------------
def parse_ts(s):
    h, m, rest = s.split(":"); sec, ms = rest.replace(".", ",").split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000

def fmt(t, sep=","):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"

src = open(f"{HERE}/dtwin-copilot.srt", encoding="utf-8").read().strip()
cues, srcs = re.split(r"\n\s*\n", src), []
for block in cues:                                   # the .srt's own cues, in source time
    lines = block.strip().splitlines()
    if len(lines) < 3: continue
    m = re.match(r"(\S+)\s*-->\s*(\S+)", lines[1])
    if not m: continue
    a = parse_ts(m.group(1))
    win = window_of(a)
    if win is None or win[4] is not None: continue   # not in the cut, or the window overrides its captions
    srcs.append((a, parse_ts(m.group(2)), "\n".join(lines[2:])))
replaced = 0
for win in WINDOWS:                                  # a window's replacement cues, also source time
    if isinstance(win[4], list):
        for a, b, text in win[4]:
            assert win[0] <= a < win[1], f"override cue at {a}s is outside its window {win[0]}-{win[1]}"
            srcs.append((a, b, text)); replaced += 1
out = []
for a, b, text in sorted(srcs):
    na = remap(a)
    win = window_of(a)
    nb = (min(b, win[1]) - win[0]) / win[3] + win[2]  # clamp: a cue may run past its window's end
    if nb - na < 0.15: continue
    out.append((na, nb, text))

with open(f"{HERE}/dtwin-copilot-{NAME}.srt", "w", encoding="utf-8") as f:
    for i, (a, b, txt) in enumerate(out, 1):
        f.write(f"{i}\n{fmt(a)} --> {fmt(b)}\n{txt}\n\n")
with open(f"{HERE}/dtwin-copilot-{NAME}.vtt", "w", encoding="utf-8") as f:
    f.write("WEBVTT\n\n")
    for a, b, txt in out:
        f.write(f"{fmt(a,'.')} --> {fmt(b,'.')}\n{txt}\n\n")
print(f"captions: {len(out)} cues ({replaced} replacement) from {len(cues)} in the full .srt -> dtwin-copilot-{NAME}.srt / .vtt")
for a, b, text in out:
    cps = len(text.replace(chr(10), " ")) / (b - a)
    if cps > 22: print(f"  ⚠ {a:6.2f}-{b:6.2f} {cps:4.1f} cps — probably too fast to read: {text!r}")
