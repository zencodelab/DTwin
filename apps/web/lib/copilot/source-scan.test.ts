import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The routes the drawn edge list cannot show (design §7 P4, §10 source-scan).
 *
 * Verified on LangGraph 1.4.17 (scratchpad e2, e2b, e3): a node that returns
 * `Command({goto})` reaches ANY node and no edge is drawn for it; a router
 * that returns a `Send` bypasses its own path list; a node `errorHandler` can
 * return a goto; a subgraph can `Command({graph: Command.PARENT, goto})` out
 * of itself. `ends` and path maps are drawing hints, not runtime guards. So
 * the structure tests are only the whole truth if none of these exist — and
 * that is a property of the SOURCE, checked here.
 *
 * And the three single sites: `new Send(` only in fanout.ts, `interrupt(`
 * only in confirm.ts, `.issue(` only in apply.ts, `new Command(` only in
 * session.ts and only to resume.
 *
 * Comments are stripped by the TypeScript compiler itself (not a regex), so
 * a comment explaining why a construct is forbidden does not trip the scan,
 * and a string literal containing one does.
 */

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..', '..');
const ROOTS = [join(WEB, 'lib', 'copilot'), join(WEB, 'app', 'api', 'copilot')];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'testing' ? [] : sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The file as code only: comments removed, types erased, strings kept. */
function code(path: string): string {
  return ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    fileName: path,
  }).outputText;
}

const files = ROOTS.flatMap(sources).map((path) => ({ rel: relative(WEB, path), text: code(path) }));

const hits = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.rel).sort();

describe('source scan of lib/copilot and app/api/copilot', () => {
  it('reads the files it claims to', () => {
    const names = files.map((f) => f.rel);
    for (const expected of [
      'lib/copilot/graph.ts', 'lib/copilot/fanout.ts', 'lib/copilot/confirm.ts', 'lib/copilot/apply.ts',
      'lib/copilot/session.ts', 'lib/copilot/specialist.ts', 'lib/copilot/tools/index.ts',
      'app/api/copilot/route.ts', 'app/api/copilot/graph/route.ts',
    ]) expect(names).toContain(expected);
    expect(names.some((n) => n.includes('/testing/') || n.endsWith('.test.ts'))).toBe(false);
    // The stripper really strips: apply.ts's header names "a Command goto" in a comment.
    expect(readFileSync(join(WEB, 'lib/copilot/apply.ts'), 'utf8')).toMatch(/\bgoto\b/);
  });

  it('1. forbidden constructs appear nowhere', () => {
    expect(hits(/\bgoto\b/)).toEqual([]);
    expect(hits(/Command\s*\.\s*PARENT/)).toEqual([]);
    expect(hits(/\berrorHandler\b/)).toEqual([]);
    expect(hits(/\bsetNodeDefaults\b/)).toEqual([]);
    expect(hits(/\/weather\/generate/)).toEqual([]);
    // Gate finding (scratchpad lg/e12_updatestate.ts): `updateState(config,
    // values, asNode)` makes the next run continue from `asNode`'s edges —
    // written as `confirm`, it reaches `apply` with no person asked. A fifth
    // undrawn route; safety test 1b shows the ledger holds against it.
    expect(hits(/\b(?:bulkU|u)pdateState\b/)).toEqual([]);
  });

  it('1b. every Command carries a resume and nothing else (no update, no goto, no graph)', () => {
    // `new Command({ resume, update })` would write state as it resumes; the
    // regex below only sees the first key, so the object is read as syntax.
    const shapes: string[] = [];
    for (const f of files) {
      const src = ts.createSourceFile(f.rel, f.text, ts.ScriptTarget.ESNext, true);
      const visit = (node: ts.Node): void => {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Command') {
          const [arg] = node.arguments ?? [];
          const keys = arg && ts.isObjectLiteralExpression(arg)
            ? arg.properties.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : '?'))
            : ['<not an object literal>'];
          shapes.push(`${f.rel}: ${keys.join(',')}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(src);
    }
    expect(shapes.length).toBeGreaterThan(0);
    for (const s of shapes) expect(s).toBe('lib/copilot/session.ts: resume');
  });

  it('2. single sites: Send in fanout, interrupt in confirm, issue in apply, Command only to resume in session', () => {
    expect(hits(/new\s+Send\s*\(/)).toEqual(['lib/copilot/fanout.ts']);
    expect(hits(/(^|[^\w])interrupt\s*\(/m)).toEqual(['lib/copilot/confirm.ts']);
    expect(hits(/\.\s*issue\s*\(/)).toEqual(['lib/copilot/apply.ts']);
    expect(hits(/new\s+Command\s*\(/)).toEqual(['lib/copilot/session.ts']);
    const session = files.find((f) => f.rel === 'lib/copilot/session.ts')!.text;
    const commands = session.match(/new\s+Command\s*\([^)]{0,20}/g) ?? [];
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(c).toMatch(/new\s+Command\s*\(\s*\{\s*resume\b/);
  });

  it('confirm calls interrupt() as its first statement, and apply takes the grant as its first', () => {
    const confirm = files.find((f) => f.rel === 'lib/copilot/confirm.ts')!.text;
    expect(confirm).toMatch(/=>\s*\{\s*const resume = interrupt\(s\.pendingPlan\);/);
    const apply = files.find((f) => f.rel === 'lib/copilot/apply.ts')!.text;
    expect(apply).toMatch(/=>\s*\{\s*const grant = ledger\.take\(threadIdOf\(config\)\);/);
  });

  it('hands the issuer to makeApply and to nothing else', () => {
    const graph = files.find((f) => f.rel === 'lib/copilot/graph.ts')!.text;
    const uses = graph.match(/\bissuer\b/g) ?? [];
    // Once destructured from deps, once passed to makeApply.
    expect(uses).toHaveLength(2);
    // Stop is read through the registry's `stopRequested`, never its deadline:
    // a decision made within the plan's TTL has usually outlived the request's.
    expect(graph).toMatch(/makeApply\(issuer, ledger, log, \(t\) => registry\.stopRequested\(t\)\)/);
    // Called in graph.ts only; apply.ts is where it is defined.
    expect(hits(/(?<!function\s+)\bmakeApply\s*\(/)).toEqual(['lib/copilot/graph.ts']);
    expect(hits(/\bledger\s*\.\s*grant\s*\(/)).toEqual(['lib/copilot/confirm.ts']);
  });
});
