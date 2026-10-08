import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AddServerPage } from '../../src/pages/AddServerPage';
import { detail, tool } from './fixtures';
import { stubFetch } from './fetchStub';

describe('추가 마법사 — 도구 검토·승인 (15장 2번)', () => {
  it('turns destructive tools off by default and sends the exact selection and bindings', async () => {
    const pending = detail({
      status: 'pending_approval',
      tools: [tool('tts'), tool('delete_voice', { annotations: { destructiveHint: true } })],
    });
    const { calls } = stubFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/api/mcp/servers/fish') return { body: pending };
      if (method === 'GET' && path.startsWith('/api/mcp/presets')) return { body: [] };
      if (method === 'POST' && path === '/api/mcp/servers/fish/approve') {
        const b = body as { tools: Array<{ name: string; enabled: boolean }> };
        return {
          body: {
            status: 'active',
            approved: b.tools.filter((t) => t.enabled).map((t) => t.name),
            sync: {
              claude: { status: 'synced', at: '2026-10-08T00:00:00Z' },
              codex: { status: 'synced', at: '2026-10-08T00:00:00Z' },
              gemini: { status: 'synced', at: '2026-10-08T00:00:00Z' },
            },
          },
        };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/mcp/add?server=fish']}>
        <Routes>
          <Route path="/mcp/add" element={<AddServerPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const approve = await screen.findByRole('button', { name: /승인 \(1\/2\)/ });
    expect((screen.getByRole('checkbox', { name: /^tts/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /delete_voice/ }) as HTMLInputElement).checked).toBe(false);

    // 에이전트 기본값은 현재 바인딩 (Claude·Codex 켜짐, Gemini 꺼짐)
    expect((screen.getByRole('checkbox', { name: 'Gemini' }) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole('checkbox', { name: 'Gemini' }));

    await user.click(approve);
    await screen.findByText('1개 도구를 승인했습니다.');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      tools: [
        { name: 'tts', schemaHash: 'hash-tts', enabled: true },
        { name: 'delete_voice', schemaHash: 'hash-delete_voice', enabled: false },
      ],
      bindings: { claude: true, codex: true, gemini: true },
    });
  });

  it('refuses to approve with no agent selected', async () => {
    stubFetch(({ method, path }) => (method === 'GET' && path === '/api/mcp/servers/fish' ? { body: detail({ status: 'pending_approval', tools: [tool('tts')] }) } : undefined));
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/mcp/add?server=fish']}>
        <Routes>
          <Route path="/mcp/add" element={<AddServerPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const approve = await screen.findByRole('button', { name: /승인/ });
    await user.click(screen.getByRole('checkbox', { name: 'Claude' }));
    await user.click(screen.getByRole('checkbox', { name: 'Codex' }));
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(true));
  });
});
