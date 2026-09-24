// scene.html -> a SHORTER WebM, by rendering only selected time windows.
//
// The full timeline stays intact in scene.html, so every L.sNN reference still
// resolves — this picks which instants to photograph, it does not remove
// scenes. That is the whole reason it is safe: dropping lines from
// narration.py would leave scene.html reading `L.s03b.start` of undefined.
//
//   NODE_PATH=<dir with playwright-core> node render_cut.js cut.json [out.webm]
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

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--force-color-profile=srgb', '--allow-file-access-from-files'] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file://' + path.join(HERE, 'scene.html'));
  await p.evaluate(() => window.READY);
  const DUR = await p.evaluate(() => window.DURATION);

  // Frame times: walk each window on the FPS grid.
  const times = [];
  for (const [a, bnd] of PLAN.windows) {
    if (bnd > DUR + 1e-6) throw new Error(`window ends at ${bnd}s past the ${DUR}s timeline`);
    for (let t = a; t < bnd - 1e-9; t += 1 / FPS) times.push(t);
  }
  const N = times.length;
  console.log(`${PLAN.windows.length} window(s), ${N} frames, ${(N / FPS).toFixed(2)}s (source ${DUR}s)`);

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
    await p.evaluate((ms) => window.seek(ms), times[i] * 1000);
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
