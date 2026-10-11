import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATUS } from './colors.ts';

/**
 * Status text in the copilot panel is small (10–12 px), so WCAG AA asks
 * 4.5:1. The status hues themselves did not hold it — amber 1.7:1 and green
 * 3.2:1 on the light surface, red 3.6:1 on the dark one — and they carried
 * the panel's most safety-relevant words: "Awaiting your approval", the
 * Approve button, refusals, notices (review). Text now takes the
 * theme-aware `--status-*-text` tokens; this holds every pair.
 */

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A tint laid over a surface, as the plan card lays its amber. */
function over(tint: string, alpha: number, base: string): [number, number, number] {
  const t = rgb(tint);
  const b = rgb(base);
  return [0, 1, 2].map((i) => Math.round(alpha * t[i]! + (1 - alpha) * b[i]!)) as [number, number, number];
}

const THEMES = {
  light: block(':root {'),
  'dark (system)': block(":root:not([data-theme='light']) {"),
  'dark (chosen)': block(":root[data-theme='dark'] {"),
};

describe('status text contrast', () => {
  for (const [theme, vars] of Object.entries(THEMES)) {
    it(`holds 4.5:1 for every status text token on every panel surface (${theme})`, () => {
      const surfaces: Array<[string, [number, number, number]]> = [
        ['page', rgb(vars['--page']!)],
        ['surface-1', rgb(vars['--surface-1']!)],
        ['plan card', over(STATUS.warning, 0.08, vars['--page']!)],
        ['simulated card', over('#8b5cf6', 0.06, vars['--surface-1']!)],
      ];
      for (const token of ['--status-good-text', '--status-warning-text', '--status-critical-text']) {
        const value = vars[token];
        expect(value, `${theme} ${token}`).toMatch(/^#[0-9a-f]{6}$/i);
        for (const [name, bg] of surfaces) {
          expect(contrast(rgb(value!), bg), `${theme} ${token} on ${name}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  it('the panels colour text with the tokens, never with a raw status hue', () => {
    for (const file of ['CopilotPanel.tsx', 'GraphDiagram.tsx']) {
      const src = readFileSync(new URL(`../components/panels/${file}`, import.meta.url), 'utf8');
      expect(src, file).not.toMatch(/(?<![A-Za-z])color:\s*[^,}]*STATUS\.(good|warning|critical)/);
      expect(src, file).not.toMatch(/<text\b[^>]*fill=\{STATUS\./);
    }
  });
});
