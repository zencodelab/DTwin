"""Narration + timeline -> dtwin-copilot.srt and .vtt, timed to the voice.

Each narration line is split into short cues (at most two lines of 42
characters). A cue's start is not estimated from character counts: `say`
renders every growing prefix of the line with the same voice and rate as the
narration, and the moment speech ends in each render is where the next cue
begins. Run after gen_audio.py and timeline.py.

    python3 make_captions.py [rate]
"""
import array, json, os, re, subprocess, sys, tempfile, wave
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from narration import LINES
RATE = int(sys.argv[1]) if len(sys.argv) > 1 else 165
TL = json.load(open(f"{HERE}/timeline.json"))
MAX_LINE, MAX_CUE = 42, 84

# The narration spells some names out so the voice says them right; the
# captions show them as they are written.
DISPLAY = [("D Twin", "DTwin"), ("Lang Graph", "LangGraph"), ("level three", "Level\u00a03")]  # never break "Level 3"


def speech_bounds(text):
    """(first, last) second at which `say` is audibly speaking this text."""
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        subprocess.run(["say", "-v", "Samantha", "-r", str(RATE), "-o", f.name,
                        "--file-format=WAVE", "--data-format=LEI16@44100", text], check=True)
        with wave.open(f.name) as w:
            sr = w.getframerate()
            s = array.array("h", w.readframes(w.getnframes()))
    loud = [i for i in range(0, len(s), 64) if abs(s[i]) > 600]
    return (loud[0] / sr, loud[-1] / sr) if loud else (0.0, len(s) / sr)


def display(text):
    for a, b in DISPLAY:
        text = text.replace(a, b)
    return text


def chunks(text):
    """Break one narration line into cues, choosing the breaks all at once.

    A greedy split leaves one-word leftovers ("confirm.") on screen for a third
    of a second. Instead, every way of cutting the line at word boundaries is
    scored, and the cheapest wins: a cue must fit two lines, ends at a sentence
    if it can and a comma if not, and is penalised for being a fragment.
    """
    words = text.split(" ")
    n = len(words)

    def cost(i, j):
        piece = display(" ".join(words[i:j]))
        if not fits(piece):
            return None
        size = len(piece)
        c = ((size - 62) / 10) ** 2
        c += -40 if piece.endswith((".", "!", "?")) else -15 if piece.endswith((",", ":", ";")) else 30
        if size < 25:
            c += (25 - size) * 6
        return c

    best = [0.0] + [float("inf")] * n
    back = [0] * (n + 1)
    for j in range(1, n + 1):
        for i in range(j):
            c = cost(i, j)
            if c is not None and best[i] + c < best[j]:
                best[j], back[j] = best[i] + c, i
    cuts, j = [], n
    while j > 0:
        cuts.append((back[j], j)); j = back[j]
    return [" ".join(words[i:j]) for i, j in reversed(cuts)]


def splits(text):
    return [i for i, c in enumerate(text) if c == " "
            and len(text[:i]) <= MAX_LINE and len(text[i + 1:]) <= MAX_LINE]


def fits(text):
    """True when the text can be shown as at most two lines of MAX_LINE."""
    return len(text) <= MAX_LINE or bool(splits(text))


def two_lines(text):
    if len(text) <= MAX_LINE:
        return text
    # Balance the two lines, but never leave "the" or "of" hanging at the end of one.
    dangling = {"a", "an", "the", "of", "to", "in", "on", "at", "and", "by", "for", "from"}
    best = min(splits(text), key=lambda i: abs(len(text[:i]) - len(text[i + 1:]))
               + (40 if text[:i].rsplit(" ", 1)[-1].lower() in dangling else 0))
    return text[:best] + "\n" + text[best + 1:]


cues = []
for sid, text in LINES:
    start = TL["lines"][sid]["start"]
    parts = chunks(text)
    lead, _ = speech_bounds(text)
    begin = lead
    for k, part in enumerate(parts):
        _, end = speech_bounds(" ".join(parts[: k + 1]))
        cues.append([start + begin, start + end + 0.25, two_lines(display(part))])
        begin = end + 0.12
# never overlap the next cue; hold short ones a little longer where there is room
for a, b in zip(cues, cues[1:]):
    a[1] = min(max(a[1], a[0] + 1.2), b[0] - 0.04)


def ts(t, sep):
    ms = round(t * 1000)                      # round once, in whole milliseconds
    h, ms = divmod(ms, 3_600_000); m, ms = divmod(ms, 60_000); sec, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{sec:02}{sep}{ms:03}"


with open(f"{HERE}/dtwin-copilot.srt", "w") as f:
    for i, (a, b, t) in enumerate(cues, 1):
        f.write(f"{i}\n{ts(a, ',')} --> {ts(b, ',')}\n{t}\n\n")
with open(f"{HERE}/dtwin-copilot.vtt", "w") as f:
    f.write("WEBVTT\n\n")
    for a, b, t in cues:
        f.write(f"{ts(a, '.')} --> {ts(b, '.')}\n{t}\n\n")

durs = [b - a for a, b, _ in cues]
widest = max(len(l) for _, _, t in cues for l in t.split("\n"))
print(f"{len(cues)} cues · {min(durs):.2f}–{max(durs):.2f}s each · widest line {widest} chars "
      f"· last ends {cues[-1][1]:.2f}s of {TL['total']:.2f}s")
