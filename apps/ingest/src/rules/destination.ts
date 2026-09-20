import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Where a webhook may be sent, and sending it there and nowhere else.
 *
 * Rule config is operator-edited input that this service makes requests to, so
 * a webhook URL is a way of asking ingest to fetch something on the caller's
 * behalf from inside the network. The guard used to be a check followed by a
 * `fetch`, and that had three holes:
 *
 *  1. **The check and the connection resolved the name separately.** `lookup`
 *     said "public", then `fetch` asked DNS again and connected to whatever it
 *     was told the second time. A name with a short TTL that answers public
 *     first and 127.0.0.1 second walks straight through — DNS rebinding — and
 *     the check was looking at an address nobody connected to.
 *  2. **Only the first address was examined.** A name with one public and one
 *     private record passed, and which one the client dialled was the
 *     resolver's choice, which is to say the attacker's.
 *  3. **The range list was a handful of regexes.** It missed carrier-grade NAT,
 *     multicast and the reserved blocks, matched IPv6 link-local by the literal
 *     prefix `fe80` when the range is fe80::/10, and had no idea that
 *     `::ffff:127.0.0.1` is loopback wearing an IPv6 address.
 *
 * So: resolve once, judge EVERY address, and hand the connection exactly the
 * addresses that were judged. See docs/decisions.md §52.
 */

interface Range { cidr: string; label: string }

/** RFC 6890 special-purpose space, plus what a cloud host should never call. */
const BLOCKED_V4: Range[] = [
  { cidr: '0.0.0.0/8', label: 'this-network' },
  { cidr: '10.0.0.0/8', label: 'private' },
  { cidr: '100.64.0.0/10', label: 'carrier-grade NAT' },
  { cidr: '127.0.0.0/8', label: 'loopback' },
  // Includes 169.254.169.254, the cloud metadata endpoint — the classic target.
  { cidr: '169.254.0.0/16', label: 'link-local' },
  { cidr: '172.16.0.0/12', label: 'private' },
  { cidr: '192.0.0.0/24', label: 'IETF protocol assignments' },
  { cidr: '192.0.2.0/24', label: 'documentation' },
  { cidr: '192.168.0.0/16', label: 'private' },
  { cidr: '198.18.0.0/15', label: 'benchmarking' },
  { cidr: '198.51.100.0/24', label: 'documentation' },
  { cidr: '203.0.113.0/24', label: 'documentation' },
  { cidr: '224.0.0.0/4', label: 'multicast' },
  { cidr: '240.0.0.0/4', label: 'reserved' },
];

const BLOCKED_V6: Range[] = [
  { cidr: '::/128', label: 'unspecified' },
  { cidr: '::1/128', label: 'loopback' },
  // Embeds an IPv4 address, so a NAT64 gateway would carry the request into
  // whatever v4 range the low 32 bits name. Not worth decoding; refuse it.
  { cidr: '64:ff9b::/96', label: 'NAT64' },
  { cidr: '100::/64', label: 'discard-only' },
  { cidr: '2001:db8::/32', label: 'documentation' },
  { cidr: 'fc00::/7', label: 'unique-local' },
  { cidr: 'fe80::/10', label: 'link-local' },
  { cidr: 'ff00::/8', label: 'multicast' },
];

function compile(ranges: Range[], family: 'ipv4' | 'ipv6') {
  return ranges.map(({ cidr, label }) => {
    const [net, prefix] = cidr.split('/') as [string, string];
    const list = new BlockList();
    list.addSubnet(net, Number(prefix), family);
    return { list, label };
  });
}

const V4 = compile(BLOCKED_V4, 'ipv4');
const V6 = compile(BLOCKED_V6, 'ipv6');

/** `::ffff:a.b.c.d`, in either the dotted or the hex spelling. */
const MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/**
 * Why an address must not be contacted, or null if it may be.
 *
 * Pure, so the table above can be tested without a resolver.
 */
export function blockedReason(address: string): string | null {
  const family = isIP(address);
  if (family === 0) return 'not an IP address';

  if (family === 6) {
    // An IPv4-mapped address reaches the IPv4 host it names. Judge it as that
    // host: `::ffff:127.0.0.1` is loopback, whatever family it arrived in.
    const dotted = MAPPED_DOTTED.exec(address);
    if (dotted) return blockedReason(dotted[1]!);
    const hex = MAPPED_HEX.exec(address);
    if (hex) {
      const hi = Number.parseInt(hex[1]!, 16);
      const lo = Number.parseInt(hex[2]!, 16);
      return blockedReason(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  }

  const hit = (family === 4 ? V4 : V6).find(
    ({ list }) => list.check(address, family === 4 ? 'ipv4' : 'ipv6'));
  return hit ? hit.label : null;
}

export interface ResolvedAddress { address: string; family: 4 | 6 }

export type DestinationCheck =
  | { ok: true; url: URL; addresses: ResolvedAddress[] }
  | { ok: false; reason: string };

/** Injectable so the multi-record case can be tested without owning a domain. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true })).map((a) => ({
    address: a.address, family: a.family as 4 | 6,
  }));

/**
 * Decide whether a webhook URL may be requested, and resolve it ONCE.
 *
 * The addresses returned are the ones that were judged, and they are what
 * `postPinned` connects to. Nothing resolves the name a second time.
 *
 * Refuses if ANY record is blocked, not merely the first. Which record a client
 * dials is up to the resolver's ordering, so a name that is public "most of the
 * time" is a name whose owner chooses when it is not.
 */
export async function checkDestination(
  rawUrl: string,
  allowPrivate: boolean,
  resolve: Resolver = systemResolver,
): Promise<DestinationCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol ${url.protocol}` };
  }
  if (url.username || url.password) {
    // Credentials in a URL end up in logs and in `alert_notifications.target`.
    return { ok: false, reason: 'credentials in the URL are not accepted' };
  }

  // WHATWG URL has already normalised the exotic IPv4 spellings — decimal
  // `2130706433`, octal `0177.0.0.1`, hex — to dotted form, so a literal here
  // is one `isIP` recognises. IPv6 literals keep their brackets in `hostname`.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  let addresses: ResolvedAddress[];
  const literal = isIP(host);
  if (literal !== 0) {
    addresses = [{ address: host, family: literal as 4 | 6 }];
  } else {
    try {
      addresses = await resolve(host);
    } catch (err) {
      return { ok: false, reason: `DNS lookup failed: ${(err as Error).message}` };
    }
    if (addresses.length === 0) {
      return { ok: false, reason: 'DNS lookup returned no addresses' };
    }
  }

  if (!allowPrivate) {
    for (const { address } of addresses) {
      const reason = blockedReason(address);
      if (reason) {
        return {
          ok: false,
          reason: `resolves to a private or reserved address (${address}, ${reason})`,
        };
      }
    }
  }

  return { ok: true, url, addresses };
}

/**
 * A `lookup` that answers only with addresses already judged.
 *
 * This is the pin. `http.request` calls it instead of the system resolver, so
 * the socket can only be opened to an address `checkDestination` saw. The name
 * is still used for the Host header, for SNI and for certificate verification —
 * only the question "where is it?" has been taken away from DNS.
 */
export function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = typeof options === 'object' && options.family ? options.family : 0;
    const usable = addresses.filter((a) => wanted === 0 || a.family === wanted);
    const pool = usable.length > 0 ? usable : addresses;

    // Node asks for `all` when it is racing address families; answer in the
    // shape it asked for.
    if (typeof options === 'object' && options.all) {
      (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, pool);
      return;
    }
    const first = pool[0]!;
    callback(null, first.address, first.family);
  };
}

export interface PinnedResponse { status: number }

/**
 * POST a JSON body to a destination that has already been checked.
 *
 * `node:http` rather than `fetch`, because `fetch` offers no way to say which
 * address to connect to — and a guard that cannot constrain the connection is
 * a guard over a different request from the one that gets made. As a side
 * effect it cannot follow redirects at all, which is the behaviour wanted: a
 * public URL answering 302 to http://127.0.0.1/ is the same attack by another
 * door, and a 3xx is simply reported as the failure it is.
 */
export function postPinned(
  check: Extract<DestinationCheck, { ok: true }>,
  body: string,
  timeoutMs: number,
): Promise<PinnedResponse> {
  const { url, addresses } = check;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send({
      protocol: url.protocol,
      // Brackets off: `hostname` wants the bare literal for IPv6.
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      lookup: pinnedLookup(addresses),
      // Bounded: a hung endpoint must not pin a connection while alerts keep
      // arriving. Covers connect, TLS and the wait for a response alike.
      signal: AbortSignal.timeout(timeoutMs),
      // One request per socket. A kept-alive socket would be reused for the
      // next delivery to the same origin WITHOUT going through `lookup`, which
      // is fine for the same checked address but makes the pin harder to
      // reason about than it is worth.
      agent: false,
    }, (res) => {
      // The body is of no interest; drain it so the socket can close, and do
      // not let a receiver stream at us indefinitely.
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.end(body);
  });
}
