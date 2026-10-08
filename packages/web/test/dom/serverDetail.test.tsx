import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ServerDetailPage } from '../../src/pages/ServerDetailPage';
import { detail, tool } from './fixtures';
import { stubFetch } from './fetchStub';

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/mcp/servers/fish']}>
      <Routes>
        <Route path="/mcp/servers/:id" element={<ServerDetailPage />} />
        <Route path="/mcp" element={<p>목록 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const approved = (name: string, enabled = true) => tool(name, { approvedHash: `hash-${name}`, pendingApproval: false, enabled });

describe('서버 상세 (15장 3번)', () => {
  it('toggles a single tool with PATCH { tools: [{ name, enabled }] }', async () => {
    let current = detail({ tools: [approved('tts'), approved('list_voices')] });
    const { calls } = stubFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/api/mcp/servers/fish') return { body: current };
      if (method === 'PATCH' && path === '/api/mcp/servers/fish') {
        const b = body as { tools: Array<{ name: string; enabled: boolean }> };
        current = { ...current, tools: current.tools.map((t) => (t.name === b.tools[0]?.name ? { ...t, enabled: b.tools[0]!.enabled } : t)) };
        return { body: current };
      }
      if (method === 'GET' && (path.startsWith('/api/mcp/audit') || path.startsWith('/api/mcp/events'))) return { body: { items: [], nextCursor: null } };
      return undefined;
    });
    const user = userEvent.setup();
    renderDetail();
    await screen.findAllByText('tts');
    const ttsItem = screen.getAllByText('tts').map((el) => el.closest('li')).find(Boolean) as HTMLElement;
    const toggle = within(ttsItem).getByRole('switch');
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await user.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ tools: [{ name: 'tts', enabled: false }] });
    await waitFor(() => expect((within(ttsItem).getByRole('switch') as HTMLInputElement).checked).toBe(false));
  });

  it('only deletes after the server id is typed, then returns to the list', async () => {
    const { calls } = stubFetch(({ method, path }) => {
      if (method === 'GET' && path === '/api/mcp/servers/fish') return { body: detail({ tools: [approved('tts')] }) };
      if (method === 'DELETE' && path === '/api/mcp/servers/fish') {
        return { body: { status: 'deleted', steps: [{ step: 'block', ok: true }, { step: 'sync', ok: true }, { step: 'row', ok: true }] } };
      }
      if (method === 'GET' && (path.startsWith('/api/mcp/audit') || path.startsWith('/api/mcp/events'))) return { body: { items: [], nextCursor: null } };
      return undefined;
    });
    const user = userEvent.setup();
    renderDetail();
    await screen.findAllByText('tts');
    const openButtons = screen.getAllByRole('button', { name: '삭제' });
    await user.click(openButtons[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: '삭제' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('서버 id'), 'fis');
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('서버 id'), 'h');
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    await screen.findByText('목록 화면');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});
