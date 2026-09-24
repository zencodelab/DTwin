# DTwin copilot — explainer video

A narrated walkthrough of the supervisory-control copilot: the LangGraph, the
safety property it rests on, and **one real run** end to end, from the
operator's request to the setpoints on the live map.
1920×1080, 30 fps, ~3:03.

| File | What it is |
|---|---|
| `dtwin-copilot-narrated.mp4` | **H.264 + narration — use this one** (not committed) |
| `dtwin-copilot.mp4` | Silent H.264 (not committed) |
| `scene.html` | **The source.** Deterministic: `window.seek(ms)` draws any instant |
| `capture.ts` | Records a real run of the real graph, node by node → `run.json` |
| `run.json` · `graph.json` · `db.json` | The recording: transcript + timings, the graph's own edge list, the resulting database rows |
| `make_data.py` | The three JSON files → `data.js` (a `file://` page cannot fetch JSON) |
| `narration.py` | The narration, one line per scene |
| `gen_audio.py` | Narration → one WAV per line, with its measured length |
| `timeline.py` | Measured lengths → scene windows → `timeline.js` / `timeline.json` |
| `assemble_audio.py` | Per-line WAVs → `audio/narration.wav`, each at its line's start |
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
