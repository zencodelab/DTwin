# DTwin copilot — explainer video

A narrated walkthrough of the supervisory-control copilot: the LangGraph, the
safety property it rests on, and **one real run** end to end, from the
operator's request to the setpoints on the live map.
1920×1080, 30 fps. Full version ~3:03; a 1:40 cut for the feed, below.

| File | What it is |
|---|---|
| `dtwin-copilot-full-cc-music.mp4` | **Full video, intro sped up, captions burned in, background music — 2:50** (not committed) |
| `dtwin-copilot-full-cc.mp4` | Same, silent (not committed) |
| `music_bed.py` · `to_mp4_music.sh` | **Background music** — see below |
| `dtwin-copilot-short-cc.mp4` | Silent 1:40 cut, captions burned in (not committed) |
| `dtwin-copilot-short.mp4` | Silent 1:40 cut, no captions (not committed) |
| `dtwin-copilot-short-narrated.mp4` | 1:40 cut with narration (not committed) |
| `dtwin-copilot-narrated.mp4` | Full 3:03, H.264 + narration (not committed) |
| `dtwin-copilot.mp4` | Silent H.264, full length (not committed) |
| `cut.json` · `full.json` · `render_cut.js` · `cut_audio_captions.py` | **The cuts** — see below |
| `scene.html` | **The source.** Deterministic: `window.seek(ms)` draws any instant |
| `capture.ts` | Records a real run of the real graph, node by node → `run.json` |
| `run.json` · `graph.json` · `db.json` | The recording: transcript + timings, the graph's own edge list, the resulting database rows |
| `make_data.py` | The three JSON files → `data.js` (a `file://` page cannot fetch JSON) |
| `narration.py` | The narration, one line per scene |
| `gen_audio.py` | Narration → one WAV per line, with its measured length |
| `timeline.py` | Measured lengths → scene windows → `timeline.js` / `timeline.json` |
| `assemble_audio.py` | Per-line WAVs → `audio/narration.wav`, each at its line's start |
| `make_captions.py` | Narration + timeline → `dtwin-copilot.srt` / `.vtt`, each cue timed against `say` renders of the line so far |
| `db_snapshot.sh` | The audit-trail rows and Level 3 temperatures → `db.json` |
| `render.js` | Frames → WebM master |
| `assets/` | The Level 3 screenshot, and Inter (SIL OFL 1.1 — `inter-OFL.txt`) |
| `to_mp4.sh` · `to_mp4_narrated.sh` | WebM (+ narration) → MP4 via VLC |

## Nothing in it is mocked

Every number on screen comes from a file in this folder, and every file came
from the running stack on 24 Sep 2026:

- **The graph** is `GET /api/copilot/graph` — the compiled graph's own edge
  list, the same one the app draws and the structural tests read. Only node
  positions are chosen by hand, as in `GraphDiagram.tsx`.
- **The run** is `capture.ts` driving the production graph with the real model
  (`claude-opus-5`) and the real backend, bound to a real user, so every dry
  run and every issue carried that person's `x-acting-user`. It adds two
  wrappers that note what happened and when; neither changes what is sent.
- **The clock** in the run panel is the recorded graph time. The video spends
  longer on each step than the run did; the order and the recorded times are
  unchanged. The pause at `confirm` is not real time — the capture resumed
  straight away, which is why the clock reads 42.0 s either side of it.
- **The audit trail** is `control_commands`, queried after the run.
- **The map** is a screenshot of the dashboard five minutes later, and the
  temperatures on the callouts are the latest good readings at that moment.

Two things are recreations, drawn in the app's style from the recorded data:
the copilot panel (the capture ran headless, not through the browser) and
the cursor pressing Approve.

## Re-making it

```bash
# 0. The dev stack must be running (ingest, sim, web) with control enabled.
# 1. Record a run. APPROVING ISSUES REAL, EXPIRING OVERRIDES — development only.
set -a && . ./.env && set +a
npx tsx --tsconfig apps/web/tsconfig.json video/capture.ts \
  <tenantId> <userId> "Pre-cool the Level 3 offices ahead of this afternoon's peak." approved
curl -s localhost:3000/api/copilot/graph > video/graph.json
video/db_snapshot.sh "<UTC moment of the map screenshot>"

# 2. Data, narration, timing
cd video
python3 make_data.py
python3 gen_audio.py            # macOS `say`, Samantha, rate 165
python3 timeline.py
python3 assemble_audio.py
python3 make_captions.py        # captions; product names shown as written, not as spoken

# 3. Picture and mux (~6 min)
NODE_PATH=<dir containing playwright-core> node render.js
./to_mp4.sh dtwin-copilot.webm dtwin-copilot.mp4
./to_mp4_narrated.sh dtwin-copilot.webm "$PWD/audio/narration.wav" dtwin-copilot-narrated.mp4
```

A new run changes the transcript, the timings and possibly the path through
the graph. `scene.html` reads all of those from `data.js`, but its beats are
keyed to the narration — if the model takes a different route (a refusal, a
second round of dry runs), the narration and the `MOVES` list in the scene
need to follow it.

The pipeline is the one the Markaba AI workflow video used
(`MarketPlace/video/`): no ffmpeg install (the renderer uses the one in
Playwright's cache, VP8 only), VLC for the MP4 step, audio muxed during that
transcode rather than afterwards.

## The short cut

3:03 is long for a social feed. `cut.json` defines a **1:40** version as three
contiguous windows of the same timeline:

| Window | Keeps | Source |
|---|---|---|
| 1 | the graph is generated, and the whole safety argument with its test | 26.20 → 61.78 |
| 2 | proposes → suspends at `confirm` → approved → applied | 89.97 → 131.06 |
| 3 | the limits, and the end card | 159.36 → 183.03 |

Dropped: the intro, "it writes back", the zone read, the first dry run, the live
map, and the decline branch.

**Nothing is re-synthesised and `scene.html` is not touched.** That is the point
of doing it this way: the file references every line id from `s00` to `s12`, so
deleting scenes from `narration.py` would leave it reading `L.s03b.start` of
`undefined`. Instead the timeline stays whole and `render_cut.js` simply
photographs fewer instants of it — `window.seek(ms)` is deterministic, so the
frames are identical to the ones the full render produces.
`cut_audio_captions.py` does the same arithmetic for sound and text, reusing the
per-line WAVs and the existing cues, so the cut cannot drift from what was said.

Each window **opens 0.3 s before its first spoken line**: by then the scene has
finished its lead-in and is fully drawn, and no speech is clipped. Opening on
the scene boundary instead produced a near-black first frame — a poor thumbnail
and a poor first second on autoplay.

```bash
cd video
python3 cut_audio_captions.py                       # audio/narration-short.wav + dtwin-copilot-short.srt/.vtt
NODE_PATH=<dir with playwright-core> node render_cut.js cut.json
./to_mp4.sh dtwin-copilot-short.webm dtwin-copilot-short.mp4            # silent
./to_mp4_narrated.sh dtwin-copilot-short.webm "$PWD/audio/narration-short.wav" \
  dtwin-copilot-short-narrated.mp4                                      # narrated

# silent, captions burned into the frames (the posted version):
NODE_PATH=<dir with playwright-core> node render_cut.js cut.json \
  dtwin-copilot-short-cc.webm --burn
./to_mp4.sh dtwin-copilot-short-cc.webm dtwin-copilot-short-cc.mp4
```

`--burn` draws the cut's own `.srt` into each frame, and `--preview 1.5,52,96`
writes PNGs at those cut times instead of a video, so placement can be checked
without paying for a full render. The caption sits 58 px from the bottom, below
everything the scenes draw — checked at the opening JSON panel, the graph with
its test, and the copilot panel's buttons.

All of these are kept. The posted version is **silent with captions burned
in** (which file: see "The full version with a faster intro" below) — the
narration is a synthetic macOS voice, and no voice reads better than an
obviously synthetic one.

With no audio track the captions stop being an accessibility nicety and become
the content, which is why they are burned in rather than shipped as a sidecar:
an `.srt` is a toggle, and a viewer whose captions are off would get the
pictures and none of the reasoning. **Do not attach the `.srt` alongside the
burned version** — they would double up on screen.

To change what the cut keeps, edit the windows in `cut.json` and re-run both —
they read the same file, so the picture and the sound cannot disagree.

## The full version with a faster intro

`full.json` is the whole video with the first 25.70 s — the title card and the
"writes back" scene — sped up. A window may carry a `speed`; the renderer then
samples that stretch of the timeline more sparsely, so it plays faster at the
same frame rate:

| Window | Speed | Why |
|---|---|---|
| 0 → 10.65 (title) | **2.5×** | a static two-line card does not need ten seconds |
| 10.65 → 25.70 (writes back) | **1.75×** | a heading, then three cards whose own text carries the point |
| 25.70 → end | 1× | unchanged |

Result: 2:50 instead of 3:03, silent, captions burned in.

**Speeding up a scene speeds up its captions**, and those eight cues were
already at the reading-speed ceiling (14–21 characters per second, being timed
to speech). At 2× they would flash past at 30–50 cps. So a sped-up window can
**replace** its cues: `"captions": [[srcStart, srcEnd, text], …]` in source
time, remapped like any other cue. `full.json` gives each of the two scenes one
caption held for the whole scene — the original words, merged — and lets the
cards speak for themselves. `cut_audio_captions.py` prints a warning for any cue
over 22 cps so this cannot regress silently.

`speed` is for silent renders only. The per-line narration cannot be
time-stretched here, and `cut_audio_captions.py` refuses to write an audio
track for a plan with any sped-up window rather than produce a wrong one.

```bash
cd video
python3 cut_audio_captions.py full.json          # dtwin-copilot-full.srt / .vtt (no audio — silent plan)
NODE_PATH=<dir with playwright-core> node render_cut.js full.json dtwin-copilot-full-cc.webm --burn
./to_mp4.sh dtwin-copilot-full-cc.webm dtwin-copilot-full-cc.mp4
```

## Background music

The bed is two Apple Loops from the GarageBand library, tiled to the length of
the render by `music_bed.py`:

| Loop | Gain | Why |
|---|---|---|
| `Legend Synth Drone` | 1.0 | the steadiest loop in the library (level varies ~10% across 250 ms windows), sustained not percussive, and its last second is at the same level as its first, so it repeats without a bump |
| `Legend Dark Synth Pad` | 0.5 | same family, so same key and the same 23.9 s length — adds movement to the drone and stays in sync when tiled |

The choice was measured, not heard: fourteen pad/drone candidates were
converted and scored on level steadiness, crest factor and start-vs-end level.
Each loop gets a 100 ms equal-power crossfade of its tail into its head before
tiling, then the mix is faded in over 1.5 s, out over 5 s, and normalised to a
−9 dBFS peak (about −18 dBFS RMS) — background level for a video whose content
is the captions.

**Licence.** The loops stay in `/Library/Audio/Apple Loops` and are referenced
from there; nothing is copied into the repository. Apple's GarageBand/Logic
licence permits using its loops in your own soundtracks and distributing the
result, and does not permit redistributing the loops themselves. The MP3s in
`~/Music` are ripped commercial songs and were not considered.

```bash
cd video
python3 music_bed.py --length 170.2 --out audio/music-full.wav \
  "/Library/Audio/Apple Loops/Apple/01 Hip Hop/Legend Synth Drone.caf:1.0" \
  "/Library/Audio/Apple Loops/Apple/01 Hip Hop/Legend Dark Synth Pad.caf:0.5"
./to_mp4_music.sh dtwin-copilot-full-cc.webm "$PWD/audio/music-full.wav" dtwin-copilot-full-cc-music.mp4
```

`--peak` sets the level, and any afconvert-readable file works as a loop, so a
different track is one command. `to_mp4_music.sh` keeps two channels where the
narration script kept one.
