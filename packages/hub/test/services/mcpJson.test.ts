import { describe, expect, it } from 'vitest';
import { idFromEntryName, isEnvPlaceholder, parseMcpServersJson } from '../../src/services/mcpJson.js';

describe('parseMcpServersJson (C2)', () => {
  it('reads the mcpServers block (Claude/Cursor) with http, sse and stdio entries', () => {
    const entries = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          fish: { type: 'http', url: 'https://api.fish.audio/mcp', headers: { Authorization: 'Bearer ${FISH_KEY}' } },
          legacy: { type: 'sse', url: 'https://old.example/sse' },
          local: { command: 'npx', args: ['-y', '@x/server'], env: { X_KEY: 'secret' } },
        },
      }),
    );
    expect(entries).toEqual([
      { name: 'fish', kind: 'http', url: 'https://api.fish.audio/mcp', transportHint: 'streamable_http', headers: { Authorization: 'Bearer ${FISH_KEY}' } },
      { name: 'legacy', kind: 'http', url: 'https://old.example/sse', transportHint: 'sse', headers: {} },
      { name: 'local', kind: 'stdio', command: 'npx', args: ['-y', '@x/server'], envKeys: ['X_KEY'] },
    ]);
  });

  it('reads VS Code "servers", a bare map, a single entry, Gemini httpUrl and Windsurf serverUrl', () => {
    expect(parseMcpServersJson('{"servers":{"a":{"type":"http","url":"https://a.example/mcp"}}}')[0]).toMatchObject({ name: 'a', url: 'https://a.example/mcp' });
    expect(parseMcpServersJson('{"b":{"url":"https://b.example/mcp"},"c":{"command":"uvx","args":["c"]}}').map((e) => e.name)).toEqual(['b', 'c']);
    expect(parseMcpServersJson('{"url":"https://single.example/mcp"}')).toEqual([
      { name: 'single.example', kind: 'http', url: 'https://single.example/mcp', transportHint: 'streamable_http', headers: {} },
    ]);
    expect(parseMcpServersJson('{"mcpServers":{"g":{"httpUrl":"https://g.example/mcp"}}}')[0]).toMatchObject({ url: 'https://g.example/mcp' });
    expect(parseMcpServersJson('{"mcpServers":{"w":{"serverUrl":"https://w.example/mcp"}}}')[0]).toMatchObject({ url: 'https://w.example/mcp' });
  });

  it('rejects malformed input with validation_error and never echoes values', () => {
    const codeOf = (text: string) => {
      try {
        parseMcpServersJson(text);
        return 'ok';
      } catch (e) {
        return `${(e as { code: string }).code}:${(e as Error).message}`;
      }
    };
    expect(codeOf('{not json')).toMatch(/^validation_error/);
    expect(codeOf('[]')).toMatch(/^validation_error/);
    expect(codeOf('{"mcpServers":{}}')).toMatch(/^validation_error/);
    expect(codeOf('{"mcpServers":{"x":{"type":"websocket","url":"wss://x"}}}')).toMatch(/type 'websocket'/);
    expect(codeOf('{"mcpServers":{"x":{"type":"stdio"}}}')).toMatch(/command/);
    const leaky = codeOf('{"mcpServers":{"x":{"url":"https://x.example","headers":{"Authorization":42}}}}');
    expect(leaky).toMatch(/^validation_error/);
    expect(leaky).not.toContain('42');
  });

  it('detects key placeholders and derives server ids', () => {
    for (const v of ['Bearer ${API_KEY}', '$TOKEN', 'Bearer <your-key>', 'YOUR_API_KEY']) expect(isEnvPlaceholder(v), v).toBe(true);
    for (const v of ['Bearer sk-live-abc123', 'abcdef']) expect(isEnvPlaceholder(v), v).toBe(false);
    expect(idFromEntryName('Fish Audio (TTS)')).toBe('fish-audio-tts');
    expect(idFromEntryName('---')).toBe('');
    expect(idFromEntryName('x'.repeat(60))).toHaveLength(40);
  });
});
