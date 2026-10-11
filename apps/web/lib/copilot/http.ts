/**
 * A reply's body as JSON, or null when it is empty or not JSON. Never throws.
 *
 * Every copilot call to another service reads its reply through this, never
 * through `res.json()`: a proxy's HTML error page or a truncated body is a
 * refusal to report, not an exception that escapes a node (v1's unguarded
 * `res.json()` bricked a thread this way). Pure and dependency-free, so the
 * scratch runner can use it without pulling the database client in.
 */
export async function readJson(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * A request's body as text, read to at most `maxBytes` — or null when it is
 * longer, which the route answers 413 before parsing anything.
 *
 * `request.json()` buffers and parses whatever arrives. The copilot's own
 * limit (2,000 characters of question) was only a Zod bound applied AFTER
 * that, and nothing in front of the route caps a body, so one POST of a few
 * hundred megabytes grew the web process — which holds every person's
 * pending plan in memory — by gigabytes (review, ADR 64). A declared length
 * over the bound is refused unread; a chunked body is counted as it is read
 * and abandoned the moment it passes the bound.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
