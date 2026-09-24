"""A background-music bed from Apple Loops, to the length of a render.

    python3 music_bed.py --length 170.2 --out audio/music-full.wav \
        "/Library/Audio/Apple Loops/Apple/01 Hip Hop/Legend Synth Drone.caf:1.0" \
        "/Library/Audio/Apple Loops/Apple/01 Hip Hop/Legend Dark Synth Pad.caf:0.5"

Each loop is converted with afconvert (macOS), made seamless with a short
equal-power crossfade of its tail into its head, tiled to the length, mixed at
its gain, faded in and out, and normalised to a peak of --peak dBFS. Pure
Python: the one loop period is mixed sample by sample, then tiled as bytes, so
a three-minute bed takes seconds rather than minutes.

The loops are referenced from the Apple Loops library, not copied into the
repository: Apple's GarageBand/Logic licence permits using them in your own
soundtracks and distributing the result, but not redistributing the loops.
"""
import argparse, array, math, os, subprocess, sys, tempfile, wave

ap = argparse.ArgumentParser()
ap.add_argument("loops", nargs="+", help="path.caf:gain")
ap.add_argument("--length", type=float, required=True, help="seconds")
ap.add_argument("--out", required=True)
ap.add_argument("--peak", type=float, default=-9.0, help="target peak, dBFS")
ap.add_argument("--fade-in", type=float, default=1.5)
ap.add_argument("--fade-out", type=float, default=5.0)
ap.add_argument("--seam", type=float, default=0.10, help="crossfade at the loop point, s")
ap.add_argument("--end-silence", type=float, default=0.2)
A = ap.parse_args()
SR, CH = 44100, 2

def load(path):
    """Any afconvert-readable file -> interleaved int16 stereo at 44.1 kHz."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        tmp = t.name
    subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{SR}", "-c", str(CH), path, tmp], check=True)
    w = wave.open(tmp); assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (SR, CH, 2), path
    a = array.array("h"); a.frombytes(w.readframes(w.getnframes())); w.close(); os.unlink(tmp)
    return a

def seamless(a, seam_s):
    """Blend the last `seam` of the loop into its first `seam`, so tiling is click-free."""
    X = int(seam_s * SR) * CH
    L = len(a) - X
    out = array.array("h", a[:L])
    for i in range(X):
        t = (i // CH) / (X // CH)
        w_in, w_out = math.sin(t * math.pi / 2), math.cos(t * math.pi / 2)   # equal power
        out[i] = int(max(-32768, min(32767, a[i] * w_in + a[L + i] * w_out)))
    return out

# --- one mixed period, as floats -------------------------------------------
parts = []
for spec in A.loops:
    path, _, g = spec.rpartition(":")
    parts.append((seamless(load(path), A.seam), float(g)))
period = min(len(p) for p, _ in parts)            # same-family loops share a length; trim if not
mix = [0.0] * period
for p, g in parts:
    for i in range(period):
        mix[i] += p[i] * g
peak = max(abs(x) for x in mix)
scale = (32768 * 10 ** (A.peak / 20)) / peak
one = array.array("h", (int(x * scale) for x in mix))
print(f"period {period / CH / SR:.2f}s from {len(parts)} loop(s); normalised ×{scale:.3f} to {A.peak} dBFS peak")

# --- tile, fade, trim -------------------------------------------------------
total = int(A.length * SR) * CH
reps = -(-total // period)
bed = array.array("h", one.tobytes() * reps)[:total]
fi, fo, es = int(A.fade_in * SR) * CH, int(A.fade_out * SR) * CH, int(A.end_silence * SR) * CH
for i in range(fi):
    bed[i] = int(bed[i] * (i // CH) / (fi // CH))
end = total - es
for i in range(fo):
    j = end - fo + i
    bed[j] = int(bed[j] * (1 - (i // CH) / (fo // CH)))
for i in range(end, total):
    bed[i] = 0
with wave.open(A.out, "wb") as w:
    w.setnchannels(CH); w.setsampwidth(2); w.setframerate(SR); w.writeframes(bed.tobytes())
rms = math.sqrt(sum(x * x for x in one) / len(one))
print(f"wrote {A.out}: {A.length:.2f}s, {reps} repeats, fade in {A.fade_in}s / out {A.fade_out}s, "
      f"peak {A.peak} dBFS, RMS {20 * math.log10(rms / 32768):.1f} dBFS")
