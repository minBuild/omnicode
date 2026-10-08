import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createMasker } from '@omnicode/shared';
import type { HeaderSecret, HubTokensSecret, OAuthSecret, SecretStore, SecretValue, StdioEnvSecret } from '../../src/contracts.js';
import {
  createAwsSecretStore,
  createFileSecretStore,
  createMemorySecretStore,
  createSecretsFacade,
  createSecretsForConfig,
  secretFilePath,
  secretStringsOf,
  withCache,
} from '../../src/secrets/index.js';

const header: HeaderSecret = { type: 'header', header_name: 'Authorization', value: 'Bearer sk-header-secret-value-0001' };
const oauth: OAuthSecret = {
  type: 'oauth',
  issuer: 'https://auth.example.com',
  client_mode: 'cimd',
  client_id: 'https://me.example/.well-known/omnicode/client.json',
  client_secret: 'client-secret-value-0002',
  token_endpoint_auth_method: 'none',
  registration_access_token: 'registration-token-0003',
  registration_client_uri: null,
  resource: 'https://api.fish.audio/mcp',
  access_token: 'access-token-value-0004',
  refresh_token: 'refresh-token-value-0005',
  expires_at: '2026-10-07T09:00:00Z',
  scope: 'tts voices',
  obtained_at: '2026-10-07T08:00:00Z',
};
const stdio: StdioEnvSecret = { type: 'stdio_env', env: { FISH_API_KEY: 'fish-api-key-value-0006', EMPTY: '' } };
const hub: HubTokensSecret = { claude: 'omh_claude_token_value_0007', codex: 'omh_codex_token_value_0008', gemini: 'omh_gemini_token_value_0009', rotated_at: {} };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function storeContract(name: string, make: () => SecretStore) {
  describe(`${name} store contract`, () => {
    it('put/get/delete round trip, missing → undefined, delete is idempotent', async () => {
      const s = make();
      expect(await s.get('omnicode/mcp/x')).toBeUndefined();
      await s.put('omnicode/mcp/x', header);
      expect(await s.get<HeaderSecret>('omnicode/mcp/x')).toEqual(header);
      await s.put('omnicode/mcp/x', oauth); // 덮어쓰기
      expect(await s.get<OAuthSecret>('omnicode/mcp/x')).toEqual(oauth);
      await s.put('omnicode/hub-tokens', hub);
      expect(await s.get<HubTokensSecret>('omnicode/hub-tokens')).toEqual(hub);
      await s.delete('omnicode/mcp/x');
      expect(await s.get('omnicode/mcp/x')).toBeUndefined();
      await expect(s.delete('omnicode/mcp/x')).resolves.toBeUndefined();
      await expect(s.delete('omnicode/mcp/never')).resolves.toBeUndefined();
    });
  });
}

storeContract('memory', () => createMemorySecretStore());
storeContract('file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omnicode-secrets-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return createFileSecretStore(path.join(dir, 'secrets'));
});

describe('memory store', () => {
  it('hands out copies, not references', async () => {
    const s = createMemorySecretStore();
    const v: StdioEnvSecret = { type: 'stdio_env', env: { A: 'aaaaaaaa' } };
    await s.put('r', v);
    v.env.A = 'mutated';
    const got = await s.get<StdioEnvSecret>('r');
    expect(got?.env.A).toBe('aaaaaaaa');
    if (got) got.env.A = 'mutated-again';
    expect((await s.get<StdioEnvSecret>('r'))?.env.A).toBe('aaaaaaaa');
    expect(s.snapshot()).toEqual({ r: { type: 'stdio_env', env: { A: 'aaaaaaaa' } } });
  });
});

describe('file store', () => {
  it('writes one 0600 file per ref inside a 0700 dir, encoding slashes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omnicode-secrets-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const secretsDir = path.join(dir, 'secrets');
    const s = createFileSecretStore(secretsDir);
    await s.put('omnicode/mcp/fish-audio', header);
    expect(statSync(secretsDir).mode & 0o777).toBe(0o700);
    const file = secretFilePath(secretsDir, 'omnicode/mcp/fish-audio');
    expect(path.basename(file)).toBe('omnicode%2Fmcp%2Ffish-audio.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(secretsDir)).toEqual(['omnicode%2Fmcp%2Ffish-audio.json']); // 임시 파일이 남지 않는다
    await s.put('omnicode/mcp/fish-audio', oauth);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(secretsDir)).toHaveLength(1);
    expect(() => secretFilePath(secretsDir, '../escape')).toThrow(TypeError);
    expect(() => secretFilePath(secretsDir, '')).toThrow(TypeError);
  });
});

describe('withCache', () => {
  function counting() {
    const inner = createMemorySecretStore();
    const calls = { get: 0, put: 0, delete: 0 };
    const store: SecretStore = {
      get: (ref) => (calls.get++, inner.get(ref)),
      put: (ref, v) => (calls.put++, inner.put(ref, v)),
      delete: (ref) => (calls.delete++, inner.delete(ref)),
    };
    return { store, calls, inner };
  }

  it('reads the cache first, writes through, and does not cache misses', async () => {
    const { store, calls, inner } = counting();
    const c = withCache(store);
    expect(await c.get('r')).toBeUndefined();
    expect(await c.get('r')).toBeUndefined();
    expect(calls.get).toBe(2); // 미스는 캐시하지 않는다
    await inner.put('r', header); // 외부에서 생김
    expect(await c.get('r')).toEqual(header);
    expect(await c.get('r')).toEqual(header);
    expect(calls.get).toBe(3);
    expect(c.has('r')).toBe(true);

    await c.put('r', oauth);
    expect(calls.put).toBe(1);
    expect(await c.get('r')).toEqual(oauth);
    expect(calls.get).toBe(3); // put 이 캐시를 갱신했다
    expect(inner.snapshot().r).toEqual(oauth); // 원본에 먼저 썼다

    await c.delete('r');
    expect(calls.delete).toBe(1);
    expect(c.has('r')).toBe(false);
    expect(await c.get('r')).toBeUndefined();

    await c.put('r', header);
    c.invalidate('r');
    expect(c.has('r')).toBe(false);
    expect(await c.get('r')).toEqual(header);
    c.invalidate();
    expect(c.has('r')).toBe(false);
  });

  it('coalesces concurrent misses into one backend read', async () => {
    const { store, calls, inner } = counting();
    await inner.put('r', header);
    const c = withCache(store);
    const [a, b, d] = await Promise.all([c.get('r'), c.get('r'), c.get('r')]);
    expect(a).toEqual(header);
    expect(b).toEqual(header);
    expect(d).toEqual(header);
    expect(calls.get).toBe(1);
  });

  it('a failing backend put leaves the cache untouched', async () => {
    const inner = createMemorySecretStore();
    await inner.put('r', header);
    const failing: SecretStore = { ...inner, put: async () => { throw new Error('aws down'); } };
    const c = withCache(failing);
    expect(await c.get('r')).toEqual(header);
    await expect(c.put('r', oauth)).rejects.toThrow('aws down');
    expect(await c.get('r')).toEqual(header);
  });
});

describe('SecretsFacade feeds the masker', () => {
  it('extracts only secret strings per type', () => {
    expect(secretStringsOf(header)).toEqual([header.value, 'sk-header-secret-value-0001']);
    expect(secretStringsOf({ type: 'header', header_name: 'X-Api-Key', value: 'plain-key-value-0010' })).toEqual(['plain-key-value-0010']);
    expect(secretStringsOf(oauth)).toEqual(['client-secret-value-0002', 'registration-token-0003', 'access-token-value-0004', 'refresh-token-value-0005']);
    expect(secretStringsOf(stdio)).toEqual(['fish-api-key-value-0006']);
    expect(secretStringsOf(hub)).toEqual([hub.claude, hub.codex, hub.gemini]);
    expect(secretStringsOf({ ...oauth, client_secret: null, access_token: null, refresh_token: null, registration_access_token: null })).toEqual([]);
  });

  it('adds secrets on put and on get, never non-secret fields', async () => {
    const masker = createMasker();
    const inner = createMemorySecretStore();
    const facade = createSecretsFacade(inner, masker);
    await facade.put('omnicode/mcp/a', header);
    expect(masker.mask(`x ${header.value} y`)).toBe('x *** y'); // 값 전체("Bearer …")가 사전에 들어간다
    expect(masker.mask(`x ${header.value.slice('Bearer '.length)} y`)).toBe('x *** y'); // 토큰만 나와도 정규식은 못 잡지만 사전으로 잡혀야 한다
    expect(masker.size()).toBe(2);

    await inner.put('omnicode/mcp/b', oauth); // 파사드를 거치지 않고 생긴 값
    await inner.put('omnicode/hub-tokens', hub);
    await inner.put('omnicode/mcp/c', stdio);
    expect(masker.mask(oauth.access_token ?? '')).toBe(oauth.access_token);
    await facade.get('omnicode/mcp/b');
    await facade.get('omnicode/hub-tokens');
    await facade.get('omnicode/mcp/c');
    const line = `issuer=${oauth.issuer} client=${oauth.client_id} at=${oauth.access_token} rt=${oauth.refresh_token} cs=${oauth.client_secret} rat=${oauth.registration_access_token} hub=${hub.gemini} env=${stdio.env.FISH_API_KEY}`;
    expect(masker.mask(line)).toBe(`issuer=${oauth.issuer} client=${oauth.client_id} at=*** rt=*** cs=*** rat=*** hub=*** env=***`);
    expect(masker.size()).toBe(10);
    await facade.delete('omnicode/mcp/b');
    expect(masker.mask(oauth.access_token ?? '')).toBe('***'); // 삭제 후에도 사전에 남는다
    expect(await inner.get('omnicode/mcp/b')).toBeUndefined();
    expect(facade.masker).toBe(masker);
  });

  it('createSecretsForConfig wires backend + cache + facade', async () => {
    const masker = createMasker();
    const facade = createSecretsForConfig({ secretsBackend: 'memory', secretsPrefix: 'omnicode', dataDir: '/tmp/x' }, masker);
    await facade.put('omnicode/hub-tokens', hub);
    expect(masker.mask(`t=${hub.claude}`)).toBe('t=***');
    expect(await facade.get<HubTokensSecret>('omnicode/hub-tokens')).toEqual(hub);
    const dir = mkdtempSync(path.join(tmpdir(), 'omnicode-secrets-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const fileFacade = createSecretsForConfig({ secretsBackend: 'file', secretsPrefix: 'omnicode', dataDir: dir }, createMasker());
    await fileFacade.put('omnicode/mcp/a', header);
    expect(readdirSync(path.join(dir, 'secrets'))).toHaveLength(1);
  });
});

describe('AWS store (fake client)', () => {
  class AwsError extends Error {
    constructor(override readonly name: string) {
      super(name);
    }
  }
  function fakeClient(initial: Record<string, string> = {}) {
    const secrets = new Map(Object.entries(initial));
    const log: Array<{ op: string; input: Record<string, unknown> }> = [];
    const send = async (cmd: unknown): Promise<unknown> => {
      if (cmd instanceof GetSecretValueCommand) {
        log.push({ op: 'get', input: cmd.input });
        const v = secrets.get(String(cmd.input.SecretId));
        if (v === undefined) throw new AwsError('ResourceNotFoundException');
        return { SecretString: v };
      }
      if (cmd instanceof PutSecretValueCommand) {
        log.push({ op: 'put', input: cmd.input });
        const id = String(cmd.input.SecretId);
        if (!secrets.has(id)) throw new AwsError('ResourceNotFoundException');
        secrets.set(id, String(cmd.input.SecretString));
        return {};
      }
      if (cmd instanceof CreateSecretCommand) {
        log.push({ op: 'create', input: cmd.input });
        const name = String(cmd.input.Name);
        if (secrets.has(name)) throw new AwsError('ResourceExistsException');
        secrets.set(name, String(cmd.input.SecretString));
        return {};
      }
      if (cmd instanceof DeleteSecretCommand) {
        log.push({ op: 'delete', input: cmd.input });
        const id = String(cmd.input.SecretId);
        if (!secrets.has(id)) throw new AwsError('ResourceNotFoundException');
        secrets.delete(id);
        return {};
      }
      throw new Error('unexpected command');
    };
    return { secrets, log, send };
  }

  it('get: missing → undefined; existing → parsed JSON (SecretString or SecretBinary)', async () => {
    const client = fakeClient({ 'omnicode/mcp/a': JSON.stringify(header) });
    const s = createAwsSecretStore({ client, prefix: 'omnicode' });
    expect(await s.get('omnicode/mcp/missing')).toBeUndefined();
    expect(await s.get<HeaderSecret>('omnicode/mcp/a')).toEqual(header);
    const binary = createAwsSecretStore({ client: { send: async () => ({ SecretBinary: new TextEncoder().encode(JSON.stringify(hub)) }) }, prefix: 'omnicode' });
    expect(await binary.get('omnicode/hub-tokens')).toEqual(hub);
    const broken = createAwsSecretStore({ client: { send: async () => { throw new AwsError('AccessDeniedException'); } }, prefix: 'omnicode' });
    await expect(broken.get('omnicode/hub-tokens')).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });

  it('put: PutSecretValue, falling back to CreateSecret for a new name (and back to Put on a race)', async () => {
    const client = fakeClient();
    const s = createAwsSecretStore({ client, prefix: 'omnicode' });
    await s.put('omnicode/mcp/a', header);
    expect(client.log.map((l) => l.op)).toEqual(['put', 'create']);
    expect(client.log[1]?.input).toMatchObject({ Name: 'omnicode/mcp/a', SecretString: JSON.stringify(header), Tags: [{ Key: 'omnicode', Value: 'omnicode' }] });
    await s.put('omnicode/mcp/a', oauth);
    expect(client.log.map((l) => l.op)).toEqual(['put', 'create', 'put']);
    expect(JSON.parse(client.secrets.get('omnicode/mcp/a') ?? '')).toEqual(oauth);

    // 경쟁: Put 은 NotFound, Create 는 Exists → 다시 Put
    let n = 0;
    const racy = {
      send: async (cmd: unknown) => {
        n++;
        if (cmd instanceof PutSecretValueCommand && n === 1) throw new AwsError('ResourceNotFoundException');
        if (cmd instanceof CreateSecretCommand) throw new AwsError('ResourceExistsException');
        return {};
      },
    };
    await createAwsSecretStore({ client: racy, prefix: 'omnicode' }).put('omnicode/mcp/b', header);
    expect(n).toBe(3);
  });

  it('delete: ForceDeleteWithoutRecovery, missing is a no-op', async () => {
    const client = fakeClient({ 'omnicode/mcp/a': JSON.stringify(header) });
    const s = createAwsSecretStore({ client, prefix: 'omnicode' });
    await s.delete('omnicode/mcp/a');
    expect(client.log[0]).toEqual({ op: 'delete', input: { SecretId: 'omnicode/mcp/a', ForceDeleteWithoutRecovery: true } });
    await expect(s.delete('omnicode/mcp/a')).resolves.toBeUndefined();
    expect(client.secrets.size).toBe(0);
  });

  it('refuses refs outside the prefix', async () => {
    const client = fakeClient();
    const s = createAwsSecretStore({ client, prefix: 'omnicode/' });
    await expect(s.get('other/mcp/a')).rejects.toThrow(/outside prefix omnicode\//);
    await expect(s.put('omnicode', header)).rejects.toThrow(TypeError);
    await expect(s.delete('omnicodex/mcp/a')).rejects.toThrow(TypeError);
    expect(client.log).toEqual([]);
    expect(() => createAwsSecretStore({ client, prefix: '/' })).toThrow(TypeError);
  });

  it('values survive a facade + cache stack', async () => {
    const client = fakeClient();
    const masker = createMasker();
    const facade = createSecretsFacade(withCache(createAwsSecretStore({ client, prefix: 'omnicode' })), masker);
    await facade.put('omnicode/mcp/a', stdio as SecretValue);
    expect(await facade.get('omnicode/mcp/a')).toEqual(stdio);
    expect(client.log.filter((l) => l.op === 'get')).toHaveLength(0); // 캐시 적중
    expect(masker.mask(stdio.env.FISH_API_KEY ?? '')).toBe('***');
  });
});
