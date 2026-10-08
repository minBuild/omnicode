import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AuthStatus } from '@omnicode/shared';
import { apiPost, isApiClientError } from '../../src/api/client';
import { AuthProvider } from '../../src/auth/AuthContext';
import { RequireAuth } from '../../src/auth/RequireAuth';
import { LoginPage } from '../../src/pages/LoginPage';
import { stubFetch } from './fetchStub';

const status = (over: Partial<AuthStatus> = {}): AuthStatus => ({
  mode: 'session',
  authenticated: true,
  setupRequired: false,
  recentAuthUntil: null,
  session: { id: 's1', createdAt: '2026-10-08T00:00:00Z', expiresAt: '2026-11-07T00:00:00Z' },
  ...over,
});

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>;
}

function shell(initial: string, protectedEl = <p>보호된 화면</p>) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<><LoginPage /><Where /></>} />
          <Route path="/setup" element={<Where />} />
          <Route path="/mcp/hub" element={<RequireAuth>{protectedEl}</RequireAuth>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('로그인 게이트 (0002 9장)', () => {
  it('sends an unauthenticated visitor to /login with the original path in next', async () => {
    stubFetch(({ path }) => (path === '/api/auth/status' ? { body: status({ authenticated: false, session: null }) } : undefined));
    shell('/mcp/hub?tab=x');
    expect((await screen.findByTestId('where')).textContent).toBe(`/login?next=${encodeURIComponent('/mcp/hub?tab=x')}`);
    // jsdom 에는 WebAuthn 이 없다 → 안내 문구와 비활성 버튼
    expect(screen.getByText(/패스키\(WebAuthn\)를 지원하지 않습니다/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '패스키로 로그인' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends everyone to /setup until the first passkey exists', async () => {
    stubFetch(({ path }) => (path === '/api/auth/status' ? { body: status({ authenticated: false, setupRequired: true, session: null }) } : undefined));
    shell('/mcp/hub');
    expect((await screen.findByTestId('where')).textContent).toBe('/setup');
  });

  it('dev mode: logs in with the dev token and returns to next', async () => {
    let authed = false;
    const { calls } = stubFetch(({ method, path, body }) => {
      if (path === '/api/auth/status') return { body: status({ mode: 'dev', authenticated: authed, session: authed ? status().session : null }) };
      if (method === 'POST' && path === '/api/auth/dev-login') {
        authed = (body as { token: string }).token === 'dev-token-0123456789';
        return authed ? { status: 204 } : { status: 401, body: { error: { code: 'unauthenticated' } } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    shell('/login?next=%2Fmcp%2Fhub');
    await user.type(await screen.findByLabelText('개발용 토큰'), 'dev-token-0123456789');
    await user.click(screen.getByRole('button', { name: '로그인' }));
    await screen.findByText('보호된 화면');
    expect(calls.some((c) => c.path === '/api/auth/dev-login')).toBe(true);
  });
});

function RotateButton() {
  const [result, setResult] = useState('');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          apiPost('/api/mcp/hub/tokens/rotate', { agents: ['claude'] }).then(
            () => setResult('ok'),
            (e: unknown) => setResult(isApiClientError(e) ? e.code : 'error'),
          );
        }}
      >
        재발급
      </button>
      <p data-testid="result">{result}</p>
    </>
  );
}

describe('재인증 창 (0002 5.3)', () => {
  it('opens one dialog on reauth_required; cancelling rejects the request with reauth_required', async () => {
    let rotateCalls = 0;
    stubFetch(({ path }) => {
      if (path === '/api/auth/status') return { body: status() };
      if (path === '/api/mcp/hub/tokens/rotate') {
        rotateCalls++;
        return { status: 401, body: { error: { code: 'reauth_required', message: 'x' } } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    shell('/mcp/hub', <RotateButton />);
    await user.click(await screen.findByRole('button', { name: '재발급' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('패스키로 한 번 더 확인')).toBeTruthy();
    // jsdom 에는 WebAuthn 이 없으므로 확인 대신 취소 경로를 검증한다
    await user.click(within(dialog).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('reauth_required'));
    expect(rotateCalls).toBe(1);
    expect(dialog.hasAttribute('open')).toBe(false);
  });
});
