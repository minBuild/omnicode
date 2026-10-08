/**
 * OAuth 완료 페이지 (10.3 콜백 처리 5, 15.8) — 정적 HTML.
 * 스크립트 없음, `code`·토큰 미포함, 렌더링하는 모든 값은 HTML 이스케이프한다.
 */
import { truncate } from '@omnicode/shared';

/** 완료 페이지 전용 CSP (인라인 스타일만 허용, 스크립트 전면 금지) */
export const CALLBACK_CSP =
  "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

/** SPA(packages/web) 응답에 붙는 CSP (16.3) */
export const SPA_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export type CallbackPageModel = { kind: 'success' } | { kind: 'failure'; code: string };

/** 오류 코드별 안내문. 코드 외의 정보(error_description 등)는 절대 표시하지 않는다. */
const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  oauth_state_invalid: '인가 요청을 확인할 수 없습니다. 요청이 만료되었거나 이미 처리되었습니다. OmniCode에서 로그인을 다시 시작하세요.',
  oauth_issuer_mismatch: '인가 서버가 예상과 달라 거부했습니다. OmniCode에서 로그인을 다시 시작하세요.',
  oauth_denied: '인가 서버에서 로그인이 거부되었습니다.',
  oauth_registration_failed: '클라이언트 등록에 실패했습니다. OmniCode의 서버 상세에서 다시 시도하세요.',
  oauth_not_applicable: '이 서버는 OAuth 로그인을 쓰지 않습니다.',
  not_found: '서버를 찾을 수 없습니다. 삭제되었을 수 있습니다.',
  probe_failed: '토큰을 받지 못했습니다. 잠시 후 다시 시도하세요.',
  internal: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.',
};
const GENERIC_FAILURE = '로그인을 완료하지 못했습니다. OmniCode에서 다시 시도하세요.';
export const SUCCESS_TEXT = '로그인이 완료되었습니다. OmniCode로 돌아가세요.';

export function renderCallbackPage(model: CallbackPageModel): string {
  const title = model.kind === 'success' ? '로그인 완료' : '로그인 실패';
  const body =
    model.kind === 'success'
      ? `<h1>로그인 완료</h1><p>${SUCCESS_TEXT}</p>`
      : `<h1>로그인 실패</h1><p>${escapeHtml(FAILURE_MESSAGES[model.code] ?? GENERIC_FAILURE)}</p>` +
        `<p class="code">오류 코드: <code>${escapeHtml(truncate(model.code, 64))}</code></p>`;
  return (
    '<!doctype html>\n' +
    '<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="referrer" content="no-referrer">\n' +
    `<title>OmniCode — ${title}</title>\n` +
    '<style>\n' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#1f2328}\n' +
    'main{max-width:28rem;padding:2rem;text-align:center}\n' +
    'h1{font-size:1.4rem;margin:0 0 .75rem}\np{margin:0 0 .5rem;line-height:1.5}\n' +
    '.code{color:#6e7781;font-size:.875rem}\ncode{font-family:ui-monospace,Menlo,monospace}\n' +
    '</style>\n</head>\n<body>\n<main>\n' +
    body +
    '\n</main>\n</body>\n</html>\n'
  );
}
