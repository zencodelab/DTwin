// scene.html -> a SHORTER WebM, by rendering only selected time windows.
//
// The full timeline stays intact in scene.html, so every L.sNN reference still
// resolves — this picks which instants to photograph, it does not remove
// scenes. That is the whole reason it is safe: dropping lines from
// narration.py would leave scene.html reading `L.s03b.start` of undefined.
//
//   NODE_PATH=<dir with playwright-core> node render_cut.js cut.json [out.webm] [--burn] [--preview t1,t2,..]
//
// --burn draws the cut's own .srt into the frames. That is for a SILENT post:
// a sidecar .srt is a toggle, and with no audio track a viewer whose captions
// are off would get the pictures and none of the argument. Burned-in captions
// cannot be turned off — so do not also attach the .srt, or they double up.
// --preview writes PNGs at the given CUT times instead of a video, for checking
// placement without paying for a full render.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const CACHE = path.join(process.env.HOME, 'Library/Caches/ms-playwright');
const pick = (re) => fs.readdirSync(CACHE).filter((d) => re.test(d)).sort().pop();
const EXEC = path.join(CACHE, pick(/^chromium-\d+$/), 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const FF = path.join(CACHE, pick(/^ffmpeg-\d+$/), 'ffmpeg-mac');
const HERE = __dirname;
const PLAN = JSON.parse(fs.readFileSync(process.argv[2] || path.join(HERE, 'cut.json'), 'utf8'));
const OUT = process.argv[3] || path.join(HERE, `dtwin-copilot-${PLAN.name}.webm`);
const FPS = 30;
const BURN = process.argv.includes('--burn');
const PREVIEW = (() => {
  const i = process.argv.indexOf('--preview');
  return i === -1 ? null : process.argv[i + 1].split(',').map(Number);
})();

// The .srt is already in CUT time (cut_audio_captions.py remapped it), and a
// frame's cut time is just index/FPS — so no further arithmetic is needed here.
function parseSrt(file) {
  const out = [];
  const ts = (v) => {
    const [h, m, rest] = v.split(':');
    const [sec, ms] = rest.replace('.', ',').split(',');
    return +h * 3600 + +m * 60 + +sec + +ms / 1000;
  };
  for (const block of fs.readFileSync(file, 'utf8').trim().split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const m = lines[1].match(/(\S+)\s*-->\s*(\S+)/);
    if (!m) continue;
    out.push({ a: ts(m[1]), b: ts(m[2]), text: lines.slice(2).join('\n') });
  }
  return out;
}
const CUES = BURN ? parseSrt(path.join(HERE, `dtwin-copilot-${PLAN.name}.srt`)) : [];
const cueAt = (t) => { const c = CUES.find((c) => t >= c.a && t < c.b); return c ? c.text : ''; };

const CAPTION_CSS = `
  #burned-cc {
    position: fixed; left: 50%; transform: translateX(-50%); bottom: 58px;
    max-width: 1180px; z-index: 99999; pointer-events: none;
    font-family: Inter, system-ui, sans-serif; font-size: 38px; font-weight: 500;
    line-height: 1.34; color: #fff; text-align: center; white-space: pre-line;
    padding: 14px 30px; border-radius: 12px;
    background: rgba(8, 10, 14, 0.82);
    box-shadow: 0 2px 28px rgba(0, 0, 0, 0.55);
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  }
  #burned-cc:empty { display: none; }`;

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--force-color-profile=srgb', '--allow-file-access-from-files'] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file://' + path.join(HERE, 'scene.html'));
  await p.evaluate(() => window.READY);
  const DUR = await p.evaluate(() => window.DURATION);
  if (BURN) {
    await p.evaluate((css) => {
      const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
      const el = document.createElement('div'); el.id = 'burned-cc'; document.body.appendChild(el);
      // seek() redraws the scene, not the DOM around it, so one node survives every frame.
      window.__cc = (t) => { document.getElementById('burned-cc').textContent = t; };
    }, CAPTION_CSS);
    console.log(`burning ${CUES.length} cues from dtwin-copilot-${PLAN.name}.srt`);
  }

  // Frame times: walk each window on the FPS grid.
  const times = [];
  for (const [a, bnd] of PLAN.windows) {
    if (bnd > DUR + 1e-6) throw new Error(`window ends at ${bnd}s past the ${DUR}s timeline`);
    for (let t = a; t < bnd - 1e-9; t += 1 / FPS) times.push(t);
  }
  const N = times.length;
  console.log(`${PLAN.windows.length} window(s), ${N} frames, ${(N / FPS).toFixed(2)}s (source ${DUR}s)`);

  if (PREVIEW) {
    const dir = path.join(HERE, 'preview'); fs.mkdirSync(dir, { recursive: true });
    for (const ct of PREVIEW) {
      const i = Math.round(ct * FPS);
      if (i >= N) { console.log(`  cut time ${ct}s is past the ${(N / FPS).toFixed(1)}s cut — skipped`); continue; }
      await p.evaluate(({ ms, text }) => { window.seek(ms); if (window.__cc) window.__cc(text); },
                       { ms: times[i] * 1000, text: cueAt(i / FPS) });
      const f = path.join(dir, `cut${String(ct).replace('.', '_')}s.png`);
      await p.screenshot({ path: f, type: 'png' });
      console.log(`  ${f}`);
    }
    await b.close();
    return;
  }

  const ff = spawn(FF, [
    '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0',
    '-c:v', 'libvpx', '-b:v', '5M', '-crf', '8', '-qmin', '4', '-qmax', '36',
    '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0', '-threads', '8', OUT,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-2000); });
  const ffDone = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c + '\n' + ffErr)))));

  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await p.evaluate(({ ms, text }) => { window.seek(ms); if (window.__cc) window.__cc(text); },
                     { ms: times[i] * 1000, text: BURN ? cueAt(i / FPS) : '' });
    const buf = await p.screenshot({ type: 'jpeg', quality: 93 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 600 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`frame ${i}/${N}  ${(100 * i / N).toFixed(0)}%  ${el.toFixed(0)}s  eta ${(el / Math.max(i, 1) * (N - i)).toFixed(0)}s`);
    }
  }
  ff.stdin.end();
  await b.close();
  await ffDone;
  console.log(`${N} frames, ${(N / FPS).toFixed(2)}s — page errors: ${errs.length ? errs.slice(0, 5) : 'none'} — ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
