import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '@omnicode/shared';
import { ENV, HubConfigError, defaultPresetsDir, loadHubConfig } from '../../src/config.js';

const pkgVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

function problemsOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadHubConfig(env);
  } catch (e) {
    if (e instanceof HubConfigError) return e.problems;
    throw e;
  }
  throw new Error('expected HubConfigError');
}

describe('loadHubConfig', () => {
  it('applies 8.5 defaults with an empty environment', () => {
    const c = loadHubConfig({});
    expect(c).toMatchObject({
      publicUrl: null,
      hubHost: '127.0.0.1',
      hubPort: 7410,
      dataDir: '/var/lib/omnicode',
      agentdSocket: '/run/omnicode/agentd.sock',
      secretsPrefix: 'omnicode',
      secretsBackend: 'aws',
      fileSecretsDir: '/var/lib/omnicode/secrets',
      callTimeoutMs: 600_000,
      idleTimeoutMs: 300_000,
      allowPrivateHosts: [],
      allowHttpLoopback: false,
      auditRetentionDays: 30,
      eventRetentionDays: 180,
      agentTokenGraceMs: 900_000,
      healthIntervalMs: DEFAULTS.healthIntervalMs,
      forwardLogMessages: true,
      cimdEnabled: true,
      registryUrl: null,
      version: pkgVersion,
    });
    expect(path.isAbsolute(c.presetsDir)).toBe(true);
    expect(c.presetsDir).toBe(defaultPresetsDir());
    expect(c.presetsDir.endsWith(`${path.sep}presets`)).toBe(true);
    expect(path.basename(path.dirname(c.presetsDir))).toBe('omnicode'); // <repo>/presets
  });

  it('parses every supported variable', () => {
    const c = loadHubConfig({
      [ENV.publicUrl]: 'https://me.example.com/',
      [ENV.hubPort]: '8081',
      [ENV.dataDir]: '/data/omnicode',
      [ENV.agentdSocket]: '/tmp/agentd.sock',
      [ENV.secretsPrefix]: 'omni-dev',
      [ENV.secretsBackend]: 'FILE',
      [ENV.fileSecretsDir]: '/data/secrets',
      [ENV.callTimeoutMs]: '120000',
      [ENV.idleTimeoutMs]: '60000',
      [ENV.allowPrivateHosts]: ' 10.0.0.0/8, mcp.internal.example ,, *.corp.example ,192.168.1.5',
      [ENV.allowHttpLoopback]: 'true',
      [ENV.auditRetentionDays]: '7',
      [ENV.eventRetentionDays]: '90',
      [ENV.agentTokenGraceMs]: '0',
      [ENV.healthIntervalMs]: '30000',
      [ENV.presetsDir]: '/opt/presets',
    });
    expect(c).toMatchObject({
      publicUrl: 'https://me.example.com',
      hubPort: 8081,
      dataDir: '/data/omnicode',
      agentdSocket: '/tmp/agentd.sock',
      secretsPrefix: 'omni-dev',
      secretsBackend: 'file',
      fileSecretsDir: '/data/secrets',
      callTimeoutMs: 120_000,
      idleTimeoutMs: 60_000,
      allowPrivateHosts: ['10.0.0.0/8', 'mcp.internal.example', '*.corp.example', '192.168.1.5'],
      allowHttpLoopback: true,
      auditRetentionDays: 7,
      eventRetentionDays: 90,
      agentTokenGraceMs: 0,
      healthIntervalMs: 30_000,
      presetsDir: '/opt/presets',
    });
  });

  it('understands boolean spellings and derives fileSecretsDir from dataDir', () => {
    for (const v of ['1', 'true', 'YES', 'on']) expect(loadHubConfig({ [ENV.allowHttpLoopback]: v }).allowHttpLoopback, v).toBe(true);
    for (const v of ['0', 'false', 'no', 'off', '']) expect(loadHubConfig({ [ENV.allowHttpLoopback]: v }).allowHttpLoopback, v).toBe(false);
    expect(loadHubConfig({ [ENV.dataDir]: '/srv/omni' }).fileSecretsDir).toBe('/srv/omni/secrets');
    expect(loadHubConfig({ [ENV.secretsBackend]: 'memory' }).secretsBackend).toBe('memory');
    expect(loadHubConfig({}).forwardLogMessages).toBe(true);
    expect(loadHubConfig({ [ENV.forwardLogMessages]: '0' }).forwardLogMessages).toBe(false);
    expect(loadHubConfig({ [ENV.cimdEnabled]: 'false' }).cimdEnabled).toBe(false);
    expect(loadHubConfig({ [ENV.registryUrl]: 'https://registry.example/' }).registryUrl).toBe('https://registry.example');
    expect(() => loadHubConfig({ [ENV.registryUrl]: 'http://registry.example' })).toThrow();
  });

  it('normalizes the public URL and allows loopback http only in dev mode', () => {
    expect(loadHubConfig({ [ENV.publicUrl]: 'https://Me.Example.com/base/' }).publicUrl).toBe('https://me.example.com/base');
    expect(problemsOf({ [ENV.publicUrl]: 'http://127.0.0.1:3000' })).toEqual([`${ENV.publicUrl}: must be an https URL`]);
    expect(loadHubConfig({ [ENV.publicUrl]: 'http://127.0.0.1:3000/', [ENV.allowHttpLoopback]: '1' }).publicUrl).toBe('http://127.0.0.1:3000');
    expect(problemsOf({ [ENV.publicUrl]: 'https://me.example.com/?x=1' })).toEqual([`${ENV.publicUrl}: must not contain query, fragment or credentials`]);
    expect(problemsOf({ [ENV.publicUrl]: 'nope' })).toEqual([`${ENV.publicUrl}: not a valid URL ("nope")`]);
  });

  it('collects every problem into one error naming the variables', () => {
    const problems = problemsOf({
      [ENV.hubPort]: 'abc',
      [ENV.callTimeoutMs]: '10',
      [ENV.allowHttpLoopback]: 'maybe',
      [ENV.allowPrivateHosts]: '10.0.0.0/33, ok.example.com, bad host',
      [ENV.secretsBackend]: 'vault',
      [ENV.dataDir]: 'relative/dir',
      [ENV.auditRetentionDays]: '0',
    });
    expect(problems.some((p) => p.startsWith(`${ENV.hubPort}: expected a non-negative integer`))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${ENV.callTimeoutMs}:`))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${ENV.allowHttpLoopback}: expected 1/0`))).toBe(true);
    expect(problems.some((p) => p.includes('10.0.0.0/33') && p.includes('bad host'))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${ENV.secretsBackend}:`))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${ENV.dataDir}:`) && p.includes('absolute'))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${ENV.auditRetentionDays}:`))).toBe(true);
    expect(problems.some((p) => p.startsWith(`${ENV.fileSecretsDir}:`) && p.includes('absolute'))).toBe(true); // dataDir 에서 파생
    expect(problems).toHaveLength(8);
    let err: unknown;
    try {
      loadHubConfig({ [ENV.hubPort]: '70000' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HubConfigError);
    expect((err as Error).message).toMatch(/invalid hub configuration:\n {2}- OMNICODE_HUB_PORT:/);
  });

  it('rejects a bad secrets prefix', () => {
    expect(problemsOf({ [ENV.secretsPrefix]: '/omnicode' })).toEqual([expect.stringMatching(/^OMNICODE_SECRETS_PREFIX:/)]);
    expect(loadHubConfig({ [ENV.secretsPrefix]: 'team/omnicode' }).secretsPrefix).toBe('team/omnicode');
  });
});
