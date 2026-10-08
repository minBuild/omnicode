import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SsrfBlockedError } from '../../src/contracts.js';
import {
  ConnectTimeoutError,
  DnsLookupError,
  PinTable,
  ResponseTooLargeError,
  TooManyRedirectsError,
  createGuardedFetch,
  createPinnedConnector,
  limitBody,
  type RawRequest,
} from '../../src/net/guardedFetch.js';
import { checkAddress } from '../../src/net/ipRanges.js';

interface Corpus {
  lookup: Record<string, string[]>;
  blocked: Array<{ url: string; reason: string; why: string }>;
  allowed: Array<{ url: string; addresses: string[] }>;
}
const corpus = JSON.parse(readFileSync(new URL('../fixtures/ssrf-corpus.json', import.meta.url), 'utf8')) as Corpus;

function corpusLookup(table: Record<string, string[]> = corpus.lookup) {
  const calls: string[] = [];
  const lookup = async (host: string): Promise<string[]> => {
    calls.push(host);
    const a = table[host];
    if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return a;
  };
  return { lookup, calls };
}

/** 가짜 전송 계층: href → 응답 공장. 호출 내역을 기록한다. */
function fakeRaw(routes: Record<string, (req: RawRequest) => Response>) {
  const calls: Array<{ href: string; method: string; headers: Record<string, string>; body: unknown; addresses: string[]; hostKey: string }> = [];
  const rawFetch = async (req: RawRequest): Promise<Response> => {
    calls.push({ href: req.url.href, method: req.method, headers: Object.fromEntries(req.headers.entries()), body: req.body, addresses: req.addresses, hostKey: req.hostKey });
    const route = routes[req.url.href];
    if (!route) throw new Error(`no fake route for ${req.url.href}`);
    return route(req);
  };
  return { rawFetch, calls };
}

const redirect = (status: number, location: string) => () => new Response(null, { status, headers: { location } });
const ok = (text = 'ok') => () => new Response(text, { status: 200 });

describe('ipRanges.checkAddress', () => {
  it('unwraps mapped and NAT64 addresses', () => {
    expect(checkAddress('::ffff:127.0.0.1')).toMatchObject({ kind: 'blocked', effective: '127.0.0.1', range: '127.0.0.0/8' });
    expect(checkAddress('64:ff9b::7f00:1')).toMatchObject({ kind: 'blocked', effective: '127.0.0.1' });
    expect(checkAddress('::ffff:93.184.216.34')).toMatchObject({ kind: 'ok', effective: '93.184.216.34' });
    expect(checkAddress('not-an-ip')).toEqual({ kind: 'invalid', address: 'not-an-ip' });
    expect(checkAddress('fe80::1%en0')).toMatchObject({ kind: 'blocked', range: 'fe80::/10' });
  });
});

describe('guardedFetch corpus (16.2)', () => {
  const { lookup } = corpusLookup();
  const { rawFetch, calls } = fakeRaw({});
  const gf = createGuardedFetch({ lookup, rawFetch });

  for (const c of corpus.blocked) {
    it(`blocks ${c.url} (${c.why})`, async () => {
      const d = await gf.check(c.url);
      expect(d.ok).toBe(false);
      expect(d.reason ?? '').toMatch(new RegExp('^' + c.reason));
      const before = calls.length;
      const err = await gf.fetch(c.url).catch((e: unknown) => e);
      if (c.reason === 'dns_error') expect(err).toBeInstanceOf(DnsLookupError);
      else if (c.reason === 'invalid_url') expect(err).toBeInstanceOf(Error);
      else expect(err).toBeInstanceOf(SsrfBlockedError);
      expect(calls.length).toBe(before); // 전송 계층에 닿지 않았다
    });
  }

  for (const a of corpus.allowed) {
    it(`allows ${a.url}`, async () => {
      const d = await gf.check(a.url);
      expect(d).toMatchObject({ ok: true, addresses: a.addresses });
    });
  }

  it('check() never throws on garbage input', async () => {
    expect(await gf.check('not a url')).toMatchObject({ ok: false, reason: 'invalid_url' });
    expect(await gf.check('')).toMatchObject({ ok: false, reason: 'invalid_url' });
  });
});

describe('allowPrivateHosts / allowHttpLoopback', () => {
  it('CIDR entries bypass the private-range block for matching addresses only', async () => {
    const { lookup } = corpusLookup();
    const gf = createGuardedFetch({ lookup, allowPrivateHosts: ['10.0.0.0/8'] });
    expect((await gf.check('https://10.0.0.5/')).ok).toBe(true);
    expect((await gf.check('https://evil.example.com/')).ok).toBe(true);
    expect((await gf.check('https://mixed.example.com/')).ok).toBe(true);
    expect((await gf.check('https://[::ffff:10.0.0.5]/')).ok).toBe(true); // mapped 를 푼 주소로 비교
    expect((await gf.check('https://192.168.1.1/')).ok).toBe(false);
    expect((await gf.check('https://169.254.169.254/')).ok).toBe(false);
  });

  it('hostname entries (exact and *.suffix) bypass the block and the localhost/dotless rule', async () => {
    const { lookup } = corpusLookup({ ...corpus.lookup, 'db.internal.example': ['192.168.1.9'], internal: ['10.1.1.1'] });
    const gf = createGuardedFetch({ lookup, allowPrivateHosts: ['evil.example.com', '*.internal.example', 'localhost', 'internal'] });
    expect((await gf.check('https://evil.example.com/')).ok).toBe(true);
    expect((await gf.check('https://EVIL.example.com/')).ok).toBe(true);
    expect((await gf.check('https://db.internal.example/')).ok).toBe(true);
    expect((await gf.check('https://localhost/')).ok).toBe(true);
    expect((await gf.check('https://internal/')).ok).toBe(true);
    expect((await gf.check('https://meta.example.com/')).ok).toBe(false);
    expect((await gf.check('https://10.0.0.5/')).ok).toBe(false); // 이름 예외는 IP 리터럴에 적용되지 않는다
  });

  it('rejects malformed allow entries up front', () => {
    expect(() => createGuardedFetch({ allowPrivateHosts: ['10.0.0.0/33'] })).toThrow(/OMNICODE_MCP_ALLOW_PRIVATE_HOSTS/);
    expect(() => createGuardedFetch({ allowPrivateHosts: ['bad host!'] })).toThrow(/invalid allow entry/);
  });

  it('allowHttpLoopback permits http to loopback hosts only, resolving to loopback only', async () => {
    const { lookup } = corpusLookup({ ...corpus.lookup, 'spoof.localhost': ['10.0.0.5'] });
    const gf = createGuardedFetch({ lookup, allowHttpLoopback: true });
    expect((await gf.check('http://127.0.0.1:7410/mcp/x')).ok).toBe(true);
    expect((await gf.check('http://localhost:7410/')).ok).toBe(true);
    expect((await gf.check('http://[::1]:7410/')).ok).toBe(true);
    expect((await gf.check('http://10.0.0.5/')).reason).toMatch(/^scheme_not_https/);
    expect((await gf.check('http://good.example.com/')).reason).toMatch(/^scheme_not_https/);
    expect((await gf.check('https://127.0.0.1/')).reason).toMatch(/^private_address/); // https 루프백은 여전히 사설
    expect((await gf.check('http://spoof.localhost/')).reason).toMatch(/^scheme_not_https/);
  });

  it('allowHttpLoopback: localhost that resolves elsewhere is refused', async () => {
    const { lookup } = corpusLookup({ localhost: ['10.0.0.5'] });
    const gf = createGuardedFetch({ lookup, allowHttpLoopback: true });
    expect((await gf.check('http://localhost/')).reason).toMatch(/^loopback_expected/);
  });
});

describe('redirect handling (manual, per-hop checks)', () => {
  it('follows a cross-origin chain, re-checking every hop and stripping credentials', async () => {
    const { lookup, calls: dns } = corpusLookup();
    const { rawFetch, calls } = fakeRaw({
      'https://good.example.com/a': redirect(302, 'https://other.example.com/b'),
      'https://other.example.com/b': redirect(301, '/c?x=1'),
      'https://other.example.com/c?x=1': ok('done'),
    });
    const gf = createGuardedFetch({ lookup, rawFetch });
    const res = await gf.fetch('https://good.example.com/a', { headers: { authorization: 'Bearer secret-token-value-1234', 'x-keep': 'yes' } });
    expect(await res.text()).toBe('done');
    expect(calls.map((c) => c.href)).toEqual(['https://good.example.com/a', 'https://other.example.com/b', 'https://other.example.com/c?x=1']);
    expect(calls[0]?.headers.authorization).toBe('Bearer secret-token-value-1234');
    expect(calls[1]?.headers.authorization).toBeUndefined();
    expect(calls[1]?.headers['x-keep']).toBe('yes');
    expect(dns).toEqual(['good.example.com', 'other.example.com', 'other.example.com']);
    expect(calls[1]?.addresses).toEqual(['93.184.216.35']);
  });

  it('303 turns POST into GET without body; 307/308 keep method and body; 301/302 POST → GET', async () => {
    const { lookup } = corpusLookup();
    const { rawFetch, calls } = fakeRaw({
      'https://good.example.com/303': redirect(303, 'https://good.example.com/after303'),
      'https://good.example.com/after303': ok(),
      'https://good.example.com/307': redirect(307, 'https://good.example.com/after307'),
      'https://good.example.com/after307': ok(),
      'https://good.example.com/308': redirect(308, 'https://good.example.com/after308'),
      'https://good.example.com/after308': ok(),
      'https://good.example.com/302': redirect(302, 'https://good.example.com/after302'),
      'https://good.example.com/after302': ok(),
    });
    const gf = createGuardedFetch({ lookup, rawFetch });
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    const headers = { 'content-type': 'application/json' };
    await gf.fetch('https://good.example.com/303', { method: 'POST', body, headers });
    await gf.fetch('https://good.example.com/307', { method: 'POST', body, headers });
    await gf.fetch('https://good.example.com/308', { method: 'PUT', body, headers });
    await gf.fetch('https://good.example.com/302', { method: 'POST', body, headers });
    const byHref = Object.fromEntries(calls.map((c) => [c.href, c]));
    expect(byHref['https://good.example.com/after303']).toMatchObject({ method: 'GET', body: null });
    expect(byHref['https://good.example.com/after303']?.headers['content-type']).toBeUndefined();
    expect(byHref['https://good.example.com/after307']).toMatchObject({ method: 'POST', body });
    expect(byHref['https://good.example.com/after307']?.headers['content-type']).toBe('application/json');
    expect(byHref['https://good.example.com/after308']).toMatchObject({ method: 'PUT', body });
    expect(byHref['https://good.example.com/after302']).toMatchObject({ method: 'GET', body: null });
  });

  it('refuses https → http downgrade', async () => {
    const { lookup } = corpusLookup();
    const { rawFetch, calls } = fakeRaw({ 'https://good.example.com/': redirect(302, 'http://good.example.com/plain') });
    const gf = createGuardedFetch({ lookup, rawFetch, allowHttpLoopback: true });
    const err = await gf.fetch('https://good.example.com/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect((err as SsrfBlockedError).reason).toMatch(/^redirect_downgrade/);
    expect(calls.length).toBe(1);
  });

  it('blocks redirects to private IPs and to hosts that resolve privately', async () => {
    const { lookup } = corpusLookup();
    const { rawFetch, calls } = fakeRaw({
      'https://good.example.com/ip': redirect(302, 'https://169.254.169.254/latest/meta-data/'),
      'https://good.example.com/host': redirect(307, 'https://evil.example.com/'),
      'https://good.example.com/mapped': redirect(302, 'https://[::ffff:10.0.0.5]/'),
    });
    const gf = createGuardedFetch({ lookup, rawFetch });
    for (const p of ['ip', 'host', 'mapped']) {
      const err = await gf.fetch(`https://good.example.com/${p}`).catch((e: unknown) => e);
      expect(err, p).toBeInstanceOf(SsrfBlockedError);
      expect((err as SsrfBlockedError).reason, p).toMatch(/^private_address/);
    }
    expect(calls.every((c) => c.hostKey === 'good.example.com')).toBe(true);
  });

  it('stops after maxRedirects hops', async () => {
    const { lookup } = corpusLookup();
    const routes: Record<string, (req: RawRequest) => Response> = {};
    for (let i = 0; i < 10; i++) routes[`https://good.example.com/${i}`] = redirect(302, `https://good.example.com/${i + 1}`);
    const { rawFetch, calls } = fakeRaw(routes);
    const gf = createGuardedFetch({ lookup, rawFetch, maxRedirects: 3 });
    await expect(gf.fetch('https://good.example.com/0')).rejects.toBeInstanceOf(TooManyRedirectsError);
    expect(calls.length).toBe(4); // 원 요청 + 3단계
  });

  it('refuses to replay a streaming body across 307', async () => {
    const { lookup } = corpusLookup();
    const { rawFetch } = fakeRaw({ 'https://good.example.com/': redirect(307, 'https://good.example.com/next'), 'https://good.example.com/next': ok() });
    const gf = createGuardedFetch({ lookup, rawFetch });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'));
        c.close();
      },
    });
    await expect(gf.fetch('https://good.example.com/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)).rejects.toThrow(/cannot be replayed/);
  });

  it('a redirect status without Location is returned as-is', async () => {
    const { lookup } = corpusLookup();
    const { rawFetch } = fakeRaw({ 'https://good.example.com/': () => new Response('weird', { status: 302 }) });
    const gf = createGuardedFetch({ lookup, rawFetch });
    const res = await gf.fetch('https://good.example.com/');
    expect(res.status).toBe(302);
    expect(await res.text()).toBe('weird');
  });
});

describe('DNS pinning / rebinding', () => {
  it('connects to the address vetted at check time; a later private answer never reaches the transport', async () => {
    let n = 0;
    const lookup = async () => (n++ === 0 ? ['93.184.216.34'] : ['10.0.0.5']);
    const { rawFetch, calls } = fakeRaw({ 'https://rebind.example.com/': ok() });
    const gf = createGuardedFetch({ lookup, rawFetch });
    await gf.fetch('https://rebind.example.com/');
    expect(n).toBe(1); // 한 요청에 DNS 한 번 — 검사 주소가 그대로 연결에 쓰인다
    expect(calls[0]?.addresses).toEqual(['93.184.216.34']);
    // 두 번째 요청은 새 DNS 응답(사설)을 다시 검사해 차단한다
    await expect(gf.fetch('https://rebind.example.com/')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls.length).toBe(1);
  });
});

/** tls/net.connect 를 흉내 내는 가짜 소켓 */
class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(_err?: Error) {
    this.destroyed = true;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
}

describe('pinned connector', () => {
  const connectOnce = (connector: ReturnType<typeof createPinnedConnector>, opts: { hostname: string; protocol: string; port: string; servername?: string }) =>
    new Promise<{ err: Error | null; socket: unknown }>((resolve) => connector({ ...opts, host: opts.hostname }, (err, socket) => resolve({ err, socket })));

  it('dials the vetted IP while keeping TLS servername = original hostname', async () => {
    const pins = new PinTable();
    pins.set('good.example.com', ['93.184.216.34']);
    const seen: Array<Record<string, unknown>> = [];
    const tlsConnect = ((o: Record<string, unknown>) => {
      seen.push(o);
      const s = new FakeSocket();
      setImmediate(() => s.emit('secureConnect'));
      return s;
    }) as unknown as typeof import('node:tls').connect;
    const connector = createPinnedConnector({ pins, connectTimeoutMs: 1000, tlsConnect });
    const r = await connectOnce(connector, { hostname: 'good.example.com', protocol: 'https:', port: '443' });
    expect(r.err).toBeNull();
    expect(seen[0]).toMatchObject({ host: '93.184.216.34', port: 443, servername: 'good.example.com' });
  });

  it('never resolves on its own: unpinned hosts are refused', async () => {
    const connector = createPinnedConnector({ pins: new PinTable(), connectTimeoutMs: 1000 });
    const r = await connectOnce(connector, { hostname: 'good.example.com', protocol: 'https:', port: '443' });
    expect(r.err).toBeInstanceOf(SsrfBlockedError);
  });

  it('falls back to the next vetted address and omits SNI for IP literals', async () => {
    const pins = new PinTable();
    pins.set('dual.example.com', ['2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34']);
    pins.set('93.184.216.34', ['93.184.216.34']);
    const hosts: string[] = [];
    const servernames: unknown[] = [];
    const tlsConnect = ((o: { host: string; servername?: string }) => {
      hosts.push(o.host);
      servernames.push(o.servername);
      const s = new FakeSocket();
      setImmediate(() => (o.host.includes(':') ? s.emit('error', new Error('ENETUNREACH')) : s.emit('secureConnect')));
      return s;
    }) as unknown as typeof import('node:tls').connect;
    const connector = createPinnedConnector({ pins, connectTimeoutMs: 1000, tlsConnect });
    const r = await connectOnce(connector, { hostname: 'dual.example.com', protocol: 'https:', port: '' });
    expect(r.err).toBeNull();
    expect(hosts).toEqual(['2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34']);
    expect(servernames).toEqual(['dual.example.com', 'dual.example.com']);
    const r2 = await connectOnce(connector, { hostname: '93.184.216.34', protocol: 'https:', port: '443' });
    expect(r2.err).toBeNull();
    expect(servernames[2]).toBeUndefined();
  });

  it('times out a hanging connect', async () => {
    const pins = new PinTable();
    pins.set('good.example.com', ['93.184.216.34']);
    const tcpConnect = (() => new FakeSocket()) as unknown as typeof import('node:net').connect;
    const connector = createPinnedConnector({ pins, connectTimeoutMs: 20, tcpConnect });
    const r = await connectOnce(connector, { hostname: 'good.example.com', protocol: 'http:', port: '80' });
    expect(r.err).toBeInstanceOf(ConnectTimeoutError);
  });
});

describe('response size limit', () => {
  const chunked = (chunks: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
          c.close();
        },
      }),
      { status: 200, headers: { 'x-a': '1' } },
    );

  it('passes bodies within the limit and preserves status/headers', async () => {
    const res = limitBody(chunked(['hello ', 'world']), 11);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-a')).toBe('1');
    expect(await res.text()).toBe('hello world');
  });

  it('fails the stream once the limit is exceeded', async () => {
    const res = limitBody(chunked(['hello ', 'world']), 8);
    await expect(res.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('rejects early on a declared content-length above the limit', () => {
    const res = new Response('x'.repeat(100), { headers: { 'content-length': '100' } });
    expect(() => limitBody(res, 50)).toThrow(ResponseTooLargeError);
  });
});

describe('end-to-end over a local http server (allowHttpLoopback)', () => {
  let server: http.Server;
  let base: string;
  let port: number;
  const received: Array<{ method: string; url: string; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', body });
        switch (req.url) {
          case '/hello':
            res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
            return;
          case '/r1':
            res.writeHead(302, { location: '/r2' }).end();
            return;
          case '/r2':
            res.writeHead(303, { location: '/final' }).end();
            return;
          case '/final':
            res.writeHead(200).end(`final:${req.method}`);
            return;
          case '/post307':
            res.writeHead(307, { location: '/echo' }).end();
            return;
          case '/echo':
            res.writeHead(200).end(`${req.method}:${body}`);
            return;
          case '/to-private':
            res.writeHead(302, { location: 'http://10.0.0.5/' }).end();
            return;
          case '/big':
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(200 * 1024) });
            res.end(Buffer.alloc(200 * 1024, 65));
            return;
          case '/big-chunked': {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            const chunk = Buffer.alloc(8 * 1024, 66);
            let i = 0;
            const tick = () => {
              if (res.destroyed) return;
              if (i++ < 40) {
                res.write(chunk);
                setImmediate(tick);
              } else res.end();
            };
            tick();
            return;
          }
          case '/hang':
            return; // 응답하지 않는다
          default:
            res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('fetches through the real undici agent with the pinned connector', async () => {
    const gf = createGuardedFetch({ allowHttpLoopback: true });
    try {
      const res = await gf.fetch(`${base}/hello`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello');
    } finally {
      await gf.close();
    }
  });

  it('uses the injected lookup for localhost and dials the pinned address', async () => {
    const { lookup, calls } = corpusLookup({ localhost: ['127.0.0.1'] });
    const gf = createGuardedFetch({ allowHttpLoopback: true, lookup });
    try {
      const res = await gf.fetch(`http://localhost:${port}/hello`);
      expect(await res.text()).toBe('hello');
      expect(calls).toEqual(['localhost']);
    } finally {
      await gf.close();
    }
  });

  it('follows 302 → 303 chains with real responses (303 becomes GET)', async () => {
    const gf = createGuardedFetch({ allowHttpLoopback: true });
    try {
      const res = await gf.fetch(`${base}/r1`, { method: 'POST', body: 'payload' });
      expect(await res.text()).toBe('final:GET');
      const res2 = await gf.fetch(`${base}/post307`, { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } });
      expect(await res2.text()).toBe('POST:payload');
    } finally {
      await gf.close();
    }
  });

  it('blocks a redirect to a private address issued by a real server', async () => {
    const gf = createGuardedFetch({ allowHttpLoopback: true });
    try {
      await expect(gf.fetch(`${base}/to-private`)).rejects.toBeInstanceOf(SsrfBlockedError);
    } finally {
      await gf.close();
    }
  });

  it('enforces maxResponseBytes on a real body (declared and streamed)', async () => {
    const gf = createGuardedFetch({ allowHttpLoopback: true, maxResponseBytes: 16 * 1024 });
    try {
      await expect(gf.fetch(`${base}/big`)).rejects.toBeInstanceOf(ResponseTooLargeError); // content-length 로 즉시
      const res = await gf.fetch(`${base}/big-chunked`); // chunked: 읽는 도중 끊는다
      await expect(res.arrayBuffer()).rejects.toBeInstanceOf(ResponseTooLargeError);
      const small = await gf.fetch(`${base}/hello`); // 풀은 계속 쓸 수 있다
      expect(await small.text()).toBe('hello');
    } finally {
      await gf.close();
    }
  });

  it('honours the caller signal', async () => {
    const gf = createGuardedFetch({ allowHttpLoopback: true });
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 30);
      await expect(gf.fetch(`${base}/hang`, { signal: ac.signal })).rejects.toThrow();
    } finally {
      await gf.close();
    }
  });
});
