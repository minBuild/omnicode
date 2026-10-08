/**
 * 16.2 주소 범위 검사. IP 파싱은 전부 ipaddr.js 에 맡긴다 (8진수·16진수·IPv4-mapped 같은 우회 표기를
 * 직접 다루지 않기 위해). 호스트 이름 규칙은 guardedFetch.ts 에 있다.
 */
import ipaddr from 'ipaddr.js';

type IPv4 = ipaddr.IPv4;
type IPv6 = ipaddr.IPv6;
type IP = IPv4 | IPv6;

/** 설계 16.2 차단 범위. `::ffff:0:0/96`(IPv4-mapped)과 `64:ff9b::/96`(NAT64)는 안의 IPv4 로 바꿔 다시 검사한다. */
export const BLOCKED_V4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const;

export const BLOCKED_V6_CIDRS = ['::/128', '::1/128', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'ff00::/8'] as const;

const V4_RANGES: Array<[string, [IPv4, number]]> = BLOCKED_V4_CIDRS.map((c) => [c, ipaddr.IPv4.parseCIDR(c)]);
const V6_RANGES: Array<[string, [IPv6, number]]> = BLOCKED_V6_CIDRS.map((c) => [c, ipaddr.IPv6.parseCIDR(c)]);
const NAT64 = ipaddr.IPv6.parseCIDR('64:ff9b::/96');
const LOOPBACK_V4 = ipaddr.IPv4.parseCIDR('127.0.0.0/8');
const LOOPBACK_V6 = ipaddr.IPv6.parseCIDR('::1/128');

export type AddressCheck =
  | { kind: 'invalid'; address: string }
  /** `effective`는 실제로 검사한 주소 (mapped/NAT64 면 안의 IPv4) */
  | { kind: 'blocked'; address: string; effective: string; range: string }
  | { kind: 'ok'; address: string; effective: string };

function parseIp(address: string): IP | null {
  try {
    return ipaddr.parse(address);
  } catch {
    return null;
  }
}

/** mapped·NAT64 를 풀어 실제 검사 대상 주소를 얻는다 */
function unwrap(ip: IP): IP {
  if (ip.kind() !== 'ipv6') return ip;
  const v6 = ip as IPv6;
  if (v6.isIPv4MappedAddress()) return v6.toIPv4Address();
  if (v6.match(NAT64)) {
    const bytes = v6.toByteArray();
    return new ipaddr.IPv4(bytes.slice(12));
  }
  return v6;
}

export function checkAddress(address: string): AddressCheck {
  const parsed = parseIp(address);
  if (!parsed) return { kind: 'invalid', address };
  const ip = unwrap(parsed);
  const effective = ip.toString();
  if (ip.kind() === 'ipv4') {
    const v4 = ip as IPv4;
    for (const [range, cidr] of V4_RANGES) if (v4.match(cidr)) return { kind: 'blocked', address, effective, range };
    return { kind: 'ok', address, effective };
  }
  const v6 = ip as IPv6;
  for (const [range, cidr] of V6_RANGES) if (v6.match(cidr)) return { kind: 'blocked', address, effective, range };
  return { kind: 'ok', address, effective };
}

/** 127.0.0.0/8 또는 ::1 (OMNICODE_MCP_ALLOW_HTTP_LOOPBACK 전용) */
export function isLoopbackAddress(address: string): boolean {
  const parsed = parseIp(address);
  if (!parsed) return false;
  const ip = unwrap(parsed);
  return ip.kind() === 'ipv4' ? (ip as IPv4).match(LOOPBACK_V4) : (ip as IPv6).match(LOOPBACK_V6);
}

// ---------------------------------------------------------------------------
// OMNICODE_MCP_ALLOW_PRIVATE_HOSTS 항목: 호스트 이름(정확히 또는 `*.suffix`) 또는 CIDR/IP
// ---------------------------------------------------------------------------
export type AllowEntry = { kind: 'host'; host: string; wildcard: boolean } | { kind: 'cidr'; cidr: [IP, number]; text: string };

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/i;

export function parseAllowEntry(raw: string): AllowEntry {
  const text = raw.trim();
  if (!text) throw new Error('empty allow entry');
  if (ipaddr.isValidCIDR(text)) return { kind: 'cidr', cidr: ipaddr.parseCIDR(text), text };
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  if (ipaddr.isValid(bare)) {
    const ip = ipaddr.parse(bare);
    return { kind: 'cidr', cidr: [ip, ip.kind() === 'ipv4' ? 32 : 128], text };
  }
  const wildcard = text.startsWith('*.');
  const host = (wildcard ? text.slice(2) : text).toLowerCase();
  if (!HOSTNAME_RE.test(host)) throw new Error(`invalid allow entry: ${text}`);
  return { kind: 'host', host, wildcard };
}

/** 잘못된 항목이 있으면 전부 모아 한 번에 던진다 */
export function parseAllowEntries(entries: readonly string[]): AllowEntry[] {
  const out: AllowEntry[] = [];
  const problems: string[] = [];
  for (const e of entries) {
    try {
      out.push(parseAllowEntry(e));
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (problems.length) throw new Error(`OMNICODE_MCP_ALLOW_PRIVATE_HOSTS: ${problems.join('; ')}`);
  return out;
}

export function hostMatchesAllowlist(hostname: string, entries: readonly AllowEntry[]): boolean {
  const h = hostname.toLowerCase();
  return entries.some((e) => e.kind === 'host' && (e.host === h || (e.wildcard && h.endsWith('.' + e.host))));
}

/** 주소(또는 mapped 를 푼 effective 주소)가 허용 CIDR 안에 있는가 */
export function addressMatchesAllowlist(address: string, entries: readonly AllowEntry[]): boolean {
  const parsed = parseIp(address);
  if (!parsed) return false;
  const ip = unwrap(parsed);
  return entries.some((e) => e.kind === 'cidr' && e.cidr[0].kind() === ip.kind() && ip.match(e.cidr));
}
