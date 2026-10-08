/**
 * 14.3 오류 형식 `{ error: { code, message, details? } }`.
 * Hub가 던지는 오류 클래스(contracts.ts)와 zod 오류를 HTTP 상태·코드로 바꾼다.
 */
import { z } from 'zod';
import { API_ERROR_STATUS, ApiError, truncate, type ApiErrorCode } from '@omnicode/shared';
import {
  AgentdUnavailableError,
  InvalidTransitionError,
  NotFoundError,
  SsrfBlockedError,
  StaleToolHashError,
  UpstreamError,
} from '@omnicode/hub';

/** 14.3의 코드 (0002 8장 인증 코드 포함). */
export type ErrorCode = ApiErrorCode;

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export interface MappedError {
  status: number;
  body: ErrorBody;
  /** 서버 쪽 결함(500대 등)이면 true — 스택을 로그에 남긴다 */
  unexpected: boolean;
}

export function errorBody(code: ErrorCode, message: string, details?: Record<string, unknown>): ErrorBody {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ValidationTarget = 'body' | 'query' | 'params';

export function zodIssues(err: z.ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code, message: i.message }));
}

export function validationError(where: ValidationTarget, issues: ValidationIssue[]): ApiError {
  return new ApiError('validation_error', '요청 형식이 올바르지 않습니다.', { in: where, issues });
}

/** zod 스키마로 검증한다. 실패하면 400 `validation_error`(details.issues) */
export function validate<S extends z.ZodType>(schema: S, data: unknown, where: ValidationTarget): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw validationError(where, zodIssues(result.error));
  return result.data as z.output<S>;
}

const MAX_MESSAGE = 300;

export function mapError(err: unknown): MappedError {
  if (err instanceof ApiError) {
    return { status: err.status, body: err.toJSON(), unexpected: err.status >= 500 };
  }
  if (err instanceof z.ZodError) {
    return { status: 400, body: validationError('body', zodIssues(err)).toJSON(), unexpected: false };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: errorBody('not_found', `찾을 수 없습니다: ${err.what}`, { what: err.what }), unexpected: false };
  }
  if (err instanceof InvalidTransitionError) {
    return {
      status: 409,
      body: errorBody('invalid_transition', `현재 상태(${err.from})에서는 허용되지 않는 요청입니다 (→ ${err.to}).`, {
        from: err.from,
        to: err.to,
      }),
      unexpected: false,
    };
  }
  if (err instanceof StaleToolHashError) {
    return {
      status: 400,
      body: errorBody('stale_tool_hash', '도구 정의가 그 사이 바뀌었습니다. 현재 정의를 다시 확인한 뒤 승인하세요.', {
        tools: err.tools.map((t) => ({ name: t.name, schemaHash: t.schema_hash, description: t.description })),
      }),
      unexpected: false,
    };
  }
  if (err instanceof SsrfBlockedError) {
    const resolved = err.resolved[0];
    return {
      status: 400,
      body: errorBody(
        'ssrf_blocked',
        resolved ? `사설 주소(${resolved})로 연결할 수 없습니다.` : `${err.host}에 연결할 수 없습니다 (${err.reason}).`,
        { host: err.host, reason: err.reason, resolved: err.resolved },
      ),
      unexpected: false,
    };
  }
  if (err instanceof AgentdUnavailableError) {
    return {
      status: 502,
      body: errorBody('agentd_unavailable', 'agentd에 연결할 수 없습니다. 잠시 후 다시 시도하세요.', {
        reason: truncate(err.message, MAX_MESSAGE),
      }),
      unexpected: false,
    };
  }
  if (err instanceof UpstreamError) {
    return {
      status: 422,
      body: errorBody('probe_failed', `업스트림 서버에 연결하지 못했습니다 (${err.kind}).`, {
        kind: err.kind,
        ...(err.info.status !== undefined ? { status: err.info.status } : {}),
        lastError: truncate(err.message, MAX_MESSAGE),
      }),
      unexpected: false,
    };
  }
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    // Fastify 자체 오류: 본문 1 MiB 초과 413, 지원하지 않는 Content-Type 415, JSON 파싱 실패 400
    const message = err instanceof Error ? truncate(err.message, MAX_MESSAGE) : '요청을 처리할 수 없습니다.';
    return { status: statusCode, body: errorBody(fastifyErrorCode(err, statusCode), message), unexpected: false };
  }
  return { status: 500, body: errorBody('internal', '내부 오류가 발생했습니다.'), unexpected: true };
}

/** Fastify 내장 4xx 를 14.3 코드로 (D5) */
export function fastifyErrorCode(err: unknown, statusCode: number): ErrorCode {
  if (statusCode === 413) return 'payload_too_large';
  if (statusCode === 415) return 'unsupported_media_type';
  const code = (err as { code?: unknown } | null)?.code;
  if (statusCode === 400 && (err instanceof SyntaxError || (typeof code === 'string' && code.startsWith('FST_ERR_CTP_')))) return 'invalid_json';
  if (statusCode === 429) return 'rate_limited';
  return 'validation_error';
}

/** 로그용 오류 필드. 메시지·스택을 마스킹한다 (16.6: 로그에 비밀값 0건). */
export function errorLogFields(err: unknown, mask: (s: string) => string): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      errName: err.name,
      errMessage: mask(err.message),
      ...(err.stack ? { errStack: mask(err.stack) } : {}),
    };
  }
  return { errValue: mask(String(err)) };
}

export function statusForCode(code: string | undefined, fallback = 400): number {
  return code !== undefined && code in API_ERROR_STATUS ? API_ERROR_STATUS[code as ApiErrorCode] : fallback;
}
