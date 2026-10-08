/**
 * 타입이 있는 fetch 래퍼. 14.3의 `{ error: { code, message, details } }`를 ApiClientError로 바꾼다.
 * DOM 전역에 의존하지 않도록 fetch를 주입할 수 있게 해 두어 node 환경 테스트가 가능하다.
 * @omnicode/shared에서는 타입만 가져온다 (런타임 코드 없음 — 번들 크기).
 */
import type { ApiErrorCode } from '@omnicode/shared';
import { errorMessages, networkErrorMessage, unexpectedResponseMessage } from '../i18n/ko';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiErrorBody {
  error: { code: string; message?: string; details?: Record<string, unknown> };
}

export class ApiClientError extends Error {
  readonly code: ApiErrorCode | 'network' | 'unexpected_response';
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  /** 서버가 보낸 원문 메시지 (있으면). userMessage는 코드 기준 한국어 문구. */
  readonly serverMessage: string | undefined;

  constructor(
    code: ApiClientError['code'],
    status: number,
    options: { serverMessage?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(userMessageFor(code, options.serverMessage), options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.serverMessage = options.serverMessage;
  }

  get userMessage(): string {
    return this.message;
  }
}

export function isApiClientError(e: unknown): e is ApiClientError {
  return e instanceof ApiClientError;
}

export function isKnownErrorCode(code: string): code is ApiErrorCode {
  return Object.prototype.hasOwnProperty.call(errorMessages, code);
}

function userMessageFor(code: ApiClientError['code'], serverMessage: string | undefined): string {
  if (code === 'network') return networkErrorMessage;
  if (code === 'unexpected_response') return serverMessage ?? unexpectedResponseMessage;
  const mapped = errorMessages[code];
  // 서버 메시지가 더 구체적인 코드(ssrf_blocked 등)는 서버 문구를 앞세운다.
  if (serverMessage && (code === 'ssrf_blocked' || code === 'validation_error' || code === 'probe_failed' || code === 'sync_failed' || code === 'upstream_error')) {
    return `${mapped} (${serverMessage})`;
  }
  return mapped;
}

/** 응답 본문(이미 파싱된 JSON)을 ApiClientError로 바꾼다. 형식이 다르면 unexpected_response. */
export function errorFromBody(status: number, body: unknown): ApiClientError {
  if (isErrorBody(body)) {
    const { code, message, details } = body.error;
    if (isKnownErrorCode(code)) {
      return new ApiClientError(code, status, { serverMessage: message, details });
    }
    return new ApiClientError('unexpected_response', status, { serverMessage: message ?? `알 수 없는 오류 코드: ${code}`, details });
  }
  return new ApiClientError('unexpected_response', status, { serverMessage: `HTTP ${status}` });
}

export function isErrorBody(x: unknown): x is ApiErrorBody {
  if (typeof x !== 'object' || x === null) return false;
  const err = (x as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  const details = (err as { details?: unknown }).details;
  if (typeof code !== 'string') return false;
  if (message !== undefined && typeof message !== 'string') return false;
  if (details !== undefined && (typeof details !== 'object' || details === null)) return false;
  return true;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

export function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export async function request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const url = path + buildQuery(options.query);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, credentials: 'same-origin', headers };
  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (cause) {
    throw new ApiClientError('network', 0, { cause });
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (res.ok) throw new ApiClientError('unexpected_response', res.status, { serverMessage: unexpectedResponseMessage });
      throw new ApiClientError('unexpected_response', res.status, { serverMessage: `HTTP ${res.status}` });
    }
  }
  if (!res.ok) throw errorFromBody(res.status, parsed);
  return parsed as T;
}

export const apiGet = <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options);
export const apiPost = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, { ...options, body });
export const apiPut = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PUT', path, { ...options, body });
export const apiPatch = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PATCH', path, { ...options, body });
export const apiDelete = <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options);

/** 어떤 예외든 사용자에게 보여줄 문구로 바꾼다. */
export function describeError(e: unknown): string {
  if (isApiClientError(e)) return e.userMessage;
  if (e instanceof Error && e.message) return e.message;
  return unexpectedResponseMessage;
}
