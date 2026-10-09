import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AddServerPage } from '../../src/pages/AddServerPage';
import { detail, tool } from './fixtures';
import { stubFetch } from './fetchStub';

describe('추가 마법사 — JSON 붙여넣기 (C2)', () => {
  it('asks which server to add when the JSON has several, and keeps stdio entries unselectable', async () => {
    const pasted = JSON.stringify({
      mcpServers: {
        remote: { type: 'http', url: 'https://remote.example/mcp' },
        local: { command: 'npx', args: ['-y', 'x'] },
      },
    });
    const { calls } = stubFetch(({ method, path, body }) => {
      if (method === 'GET' && path.startsWith('/api/mcp/presets')) return { body: [] };
      if (method === 'POST' && path === '/api/mcp/servers') {
        const b = body as { entry?: string };
        if (!b.entry) {
          return {
            status: 400,
            body: {
              error: {
                code: 'validation_error',
                message: '서버가 여러 개입니다.',
                details: { entries: [{ name: 'remote', kind: 'http', url: 'https://remote.example/mcp' }, { name: 'local', kind: 'stdio', command: 'npx' }] },
              },
            },
          };
        }
        return { status: 201, body: detail({ id: 'remote', displayName: 'remote', status: 'pending_approval', tools: [tool('t1')] }) };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/mcp/add']}>
        <Routes>
          <Route path="/mcp/add" element={<AddServerPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('tab', { name: 'JSON' }));
    fireEvent.change(screen.getByLabelText('MCP 서버 설정 JSON'), { target: { value: pasted } });
    await user.click(screen.getByRole('button', { name: 'JSON 확인' }));

    const remote = (await screen.findByRole('radio', { name: /remote/ })) as HTMLInputElement;
    const local = screen.getByRole('radio', { name: /local/ }) as HTMLInputElement;
    expect(local.disabled).toBe(true);
    const add = screen.getByRole('button', { name: '선택한 서버 추가' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await user.click(remote);
    await user.click(add);

    await screen.findByRole('button', { name: /승인/ });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => (c.body as { entry?: string }).entry)).toEqual([undefined, 'remote']);
    await waitFor(() => expect((posts[1]?.body as { json: string }).json).toBe(pasted));
  });
});

describe('추가 마법사 — 실패한 요청 뒤 입력 유지', () => {
  it('keeps the typed URL after the API rejects it', async () => {
    stubFetch(({ method, path }) => {
      if (method === 'GET' && path.startsWith('/api/mcp/presets')) return { body: [] };
      if (method === 'POST' && path === '/api/mcp/servers') {
        return { status: 400, body: { error: { code: 'ssrf_blocked', message: '사설 주소(10.0.0.5)로 연결할 수 없습니다.' } } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/mcp/add']}>
        <Routes>
          <Route path="/mcp/add" element={<AddServerPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText('서버 URL'), 'https://internal.example/mcp');
    await user.click(screen.getByRole('button', { name: '서버 확인' }));
    await screen.findByText(/사설 주소·내부 네트워크로는 연결할 수 없습니다/);
    expect((screen.getByLabelText('서버 URL') as HTMLInputElement).value).toBe('https://internal.example/mcp');
  });
});
