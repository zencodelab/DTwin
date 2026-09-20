import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blockedReason, checkDestination, pinnedLookup, postPinned,
  type ResolvedAddress, type Resolver,
} from './destination.ts';

/**
 * The SSRF guard is the kind of code that is only ever wrong in the direction
 * nobody tests: every legitimate webhook keeps working while the hole stays
 * open. The smoke suite has to open loopback to reach its own receiver, so it
 * cannot exercise the guard end to end — these do, without a network.
 */

const fixed = (...addresses: Array<[string, 4 | 6]>): Resolver =>
  async () => addresses.map(([address, family]) => ({ address, family }));

describe('blockedReason', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],     // cloud metadata
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this-network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],             // fe80::/10 runs to febf, not just fe80
    ['ff02::1', 'multicast'],
    ['64:ff9b::7f00:1', 'NAT64'],
  ])('%s is refused as %s', (address, label) => {
    expect(blockedReason(address)).toBe(label);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])(
    '%s is allowed', (address) => {
      expect(blockedReason(address)).toBeNull();
    });

  it('172.15 and 172.32 are public — the private block is 172.16/12 exactly', () => {
    expect(blockedReason('172.15.255.255')).toBeNull();
    expect(blockedReason('172.32.0.0')).toBeNull();
  });

  it('judges an IPv4-mapped IPv6 address as the IPv4 host it reaches', () => {
    // Loopback wearing an IPv6 address. The old regex list had no idea.
    expect(blockedReason('::ffff:127.0.0.1')).toBe('loopback');
    expect(blockedReason('::ffff:7f00:1')).toBe('loopback');
    expect(blockedReason('::ffff:169.254.169.254')).toBe('link-local');
    expect(blockedReason('::ffff:a00:1')).toBe('private');
    expect(blockedReason('::ffff:8.8.8.8')).toBeNull();
  });

  it('refuses something that is not an address rather than waving it through', () => {
    expect(blockedReason('localhost')).toBe('not an IP address');
    expect(blockedReason('')).toBe('not an IP address');
  });
});

describe('checkDestination', () => {
  it('refuses non-HTTP schemes and malformed URLs', async () => {
    expect((await checkDestination('file:///etc/passwd', false)).ok).toBe(false);
    expect((await checkDestination('gopher://x/', false)).ok).toBe(false);
    expect((await checkDestination('not a url', false)).ok).toBe(false);
  });

  it('refuses credentials in the URL', async () => {
    const r = await checkDestination('https://user:pw@hooks.example/x', false, fixed(['8.8.8.8', 4]));
    expect(r.ok).toBe(false);
  });

  it('judges IP literals without asking DNS', async () => {
    const never: Resolver = async () => { throw new Error('resolver must not be called'); };
    expect((await checkDestination('http://127.0.0.1/x', false, never)).ok).toBe(false);
    expect((await checkDestination('http://[::1]/x', false, never)).ok).toBe(false);
    expect((await checkDestination('http://[::ffff:127.0.0.1]/x', false, never)).ok).toBe(false);
    expect((await checkDestination('http://8.8.8.8/x', false, never)).ok).toBe(true);
  });

  it('sees through the exotic spellings of an IPv4 address', async () => {
    // WHATWG URL normalises all of these to 127.0.0.1 before the check sees them.
    const never: Resolver = async () => { throw new Error('resolver must not be called'); };
    for (const spelling of ['http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.1/']) {
      const r = await checkDestination(spelling, false, never);
      expect(r.ok, spelling).toBe(false);
    }
  });

  it('refuses a name if ANY of its records is private, not just the first', async () => {
    // One public record, one loopback. Which the client dials is the
    // resolver's ordering — the attacker's — so the public one excuses nothing.
    const mixed = fixed(['93.184.216.34', 4], ['127.0.0.1', 4]);
    const r = await checkDestination('https://mixed.example/hook', false, mixed);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('127.0.0.1');
  });

  it('resolves exactly once, and returns what it judged', async () => {
    // A rebinding name: public the first time it is asked, loopback after.
    let asked = 0;
    const rebinding: Resolver = async () =>
      (++asked === 1 ? [{ address: '93.184.216.34', family: 4 }]
                     : [{ address: '127.0.0.1', family: 4 }]);

    const r = await checkDestination('https://rebind.example/hook', false, rebinding);
    expect(r.ok).toBe(true);
    expect(asked).toBe(1);
    // The addresses handed onward are the judged ones. Nothing downstream has
    // a reason to ask again, and postPinned has no way to.
    expect(r.ok && r.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('reports a failed or empty lookup as a refusal', async () => {
    const failing: Resolver = async () => { throw new Error('ENOTFOUND'); };
    expect((await checkDestination('https://gone.example/', false, failing)).ok).toBe(false);
    expect((await checkDestination('https://empty.example/', false, fixed())).ok).toBe(false);
  });

  it('allowPrivate skips the judgement but still resolves and pins', async () => {
    const r = await checkDestination('http://internal.example/', true, fixed(['10.0.0.5', 4]));
    expect(r.ok && r.addresses).toEqual([{ address: '10.0.0.5', family: 4 }]);
  });
});

describe('pinnedLookup', () => {
  const both: ResolvedAddress[] = [
    { address: '93.184.216.34', family: 4 }, { address: '2606:4700::1', family: 6 },
  ];

  it('answers with a judged address whatever name it is asked about', () => {
    let got: unknown;
    pinnedLookup(both)('anything-at-all.example', {}, (_e, address) => { got = address; });
    expect(got).toBe('93.184.216.34');
  });

  it('honours a requested family', () => {
    let got: unknown;
    pinnedLookup(both)('x', { family: 6 }, (_e, address) => { got = address; });
    expect(got).toBe('2606:4700::1');
  });

  it('answers in list form when Node asks for all addresses', () => {
    let got: unknown;
    pinnedLookup(both)('x', { all: true }, ((_e: unknown, list: unknown) => { got = list; }) as never);
    expect(got).toEqual(both);
  });
});

describe('postPinned', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return (server.address() as AddressInfo).port;
  }

  it('connects to the pinned address, not to wherever the name resolves', async () => {
    // `.invalid` is reserved never to resolve (RFC 2606). If this request
    // consulted DNS it would fail with ENOTFOUND. It succeeds — so the socket
    // was opened to the address it was handed, and the name was only a label.
    const seen: Array<{ host: string | undefined; body: string }> = [];
    const port = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push({ host: req.headers.host, body }); res.writeHead(204).end(); });
    });

    const check = await checkDestination(
      `http://webhook.invalid:${port}/hook?x=1`, true, fixed(['127.0.0.1', 4]));
    if (!check.ok) throw new Error(check.reason);

    const res = await postPinned(check, '{"event":"alert.raised"}', 2000);
    expect(res.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe('{"event":"alert.raised"}');
    // The Host header still carries the NAME, which is what a virtual-hosted
    // receiver and TLS verification both need.
    expect(seen[0]!.host).toBe(`webhook.invalid:${port}`);
  });

  it('does not follow a redirect', async () => {
    let innerHits = 0;
    const inner = await listen((_req, res) => { innerHits++; res.writeHead(200).end(); });
    const outer = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${inner}/secret` }).end();
    });

    const check = await checkDestination(`http://127.0.0.1:${outer}/hook`, true);
    if (!check.ok) throw new Error(check.reason);

    const res = await postPinned(check, '{}', 2000);
    expect(res.status).toBe(302);
    expect(innerHits).toBe(0);
  });

  it('gives up on a receiver that never answers', async () => {
    const port = await listen(() => { /* accept and say nothing */ });
    const check = await checkDestination(`http://127.0.0.1:${port}/`, true);
    if (!check.ok) throw new Error(check.reason);
    await expect(postPinned(check, '{}', 150)).rejects.toThrow();
  });
});
