import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AddServerPage } from '../../src/pages/AddServerPage';
import { detail, tool } from './fixtures';
import { stubFetch } from './fetchStub';

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={['/mcp/add']}>
      <Routes>
        <Route path="/mcp/add" element={<AddServerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('추가 마법사 — 레지스트리 검색 (Phase 3)', () => {
  it('lists remotes, only allows plain remote URLs, pages with "더 보기", and adds with source registry', async () => {
    const { calls } = stubFetch(({ method, path, body }) => {
      if (method === 'GET' && path.startsWith('/api/mcp/presets')) return { body: [] };
      if (method === 'GET' && path.startsWith('/api/mcp/registry/search')) {
        const second = path.includes('cursor=c2');
        return {
          body: {
            enabled: true,
            source: 'registry.example',
            nextCursor: second ? null : 'c2',
            items: second
              ? [{ name: 'io.x/local', title: null, description: 'local', version: '1', websiteUrl: null, repositoryUrl: null, remotes: [], stdioOnly: true, status: 'active' }]
              : [
                  {
                    name: 'io.fish/audio',
                    title: 'Fish Audio',
                    description: 'TTS',
                    version: '1.2.0',
                    websiteUrl: 'https://fish.audio/',
                    repositoryUrl: null,
                    remotes: [
                      { type: 'streamable-http', url: 'https://api.fish.audio/mcp', templated: false, headers: ['Authorization'] },
                      { type: 'sse', url: 'https://{region}.fish.audio/sse', templated: true, headers: [] },
                    ],
                    stdioOnly: false,
                    status: 'active',
                  },
                ],
          },
        };
      }
      if (method === 'POST' && path === '/api/mcp/servers') {
        return { status: 201, body: detail({ id: 'fish-audio', displayName: (body as { displayName: string }).displayName, status: 'pending_approval', tools: [tool('tts')] }) };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('tab', { name: '검색' }));
    await user.type(screen.getByLabelText('MCP 레지스트리 검색'), 'fish');
    await user.click(screen.getByRole('button', { name: '검색' }));

    await screen.findByText('Fish Audio');
    expect(screen.getByText(/필요한 헤더: Authorization/)).toBeTruthy();
    expect(screen.getByText(/URL 변수가 필요합니다/)).toBeTruthy();
    // 템플릿 URL 에는 추가 버튼이 없다 → 버튼은 하나
    expect(screen.getAllByRole('button', { name: '이 주소로 추가' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '더 보기' }));
    await screen.findByText('io.x/local');
    expect(screen.getByText(/stdio 전용 서버입니다/)).toBeTruthy();
    expect(screen.getByText('Fish Audio')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '이 주소로 추가' }));
    await screen.findByRole('button', { name: /승인/ });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ source: 'registry', url: 'https://api.fish.audio/mcp', displayName: 'Fish Audio' });
    expect(calls.filter((c) => c.path.startsWith('/api/mcp/registry/search')).map((c) => c.path)).toEqual([
      '/api/mcp/registry/search?q=fish',
      '/api/mcp/registry/search?q=fish&cursor=c2',
    ]);
  });

  it('explains when registry search is not configured', async () => {
    stubFetch(({ path }) => {
      if (path.startsWith('/api/mcp/presets')) return { body: [] };
      if (path.startsWith('/api/mcp/registry/search')) return { body: { enabled: false, source: null, items: [], nextCursor: null } };
      return undefined;
    });
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('tab', { name: '검색' }));
    await user.click(screen.getByRole('button', { name: '검색' }));
    await screen.findByText(/OMNICODE_MCP_REGISTRY_URL/);
  });
});
