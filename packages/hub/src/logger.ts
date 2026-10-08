/**
 * 17.5 로그 — pino + 16.6 마스킹. pino 의 redact 만으로는 부족하므로 세 겹으로 가린다:
 * 1. hooks.logMethod: 로그 메서드에 들어온 모든 인자(문자열·객체·Error)를 깊이 마스킹
 * 2. formatters.log / bindings: 병합된 객체·자식 바인딩 마스킹
 * 3. hooks.streamWrite: 직렬화된 한 줄 전체를 다시 마스킹 (최종 안전망)
 */
import { pino, type DestinationStream, type Logger, type LogFn, type LoggerOptions as PinoLoggerOptions } from 'pino';
import type { Masker } from '@omnicode/shared';

export interface CreateLoggerOptions {
  level?: PinoLoggerOptions['level'];
  name?: string;
  /** 테스트에서 출력을 가로채거나, journald 외 다른 곳으로 보낼 때 */
  destination?: DestinationStream;
  /** pino base 바인딩 (pid·hostname). null 이면 없앤다 */
  base?: Record<string, unknown> | null;
}

const MAX_DEPTH = 10;

/** 문자열은 마스킹, 객체·배열은 복사하며 재귀, Error 는 평범한 객체로 바꾼다 (순환·깊이 제한). */
export function maskDeep(masker: Masker, value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return masker.mask(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[MaxDepth]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    // 프로토타입을 유지한 사본: pino 의 err 직렬화기가 type(클래스 이름)·stack 을 그대로 다루게 한다
    const clone = Object.create(Object.getPrototypeOf(value) as object) as Error;
    Object.defineProperty(clone, 'message', { value: masker.mask(value.message), writable: true, configurable: true, enumerable: false });
    if (typeof value.stack === 'string') Object.defineProperty(clone, 'stack', { value: masker.mask(value.stack), writable: true, configurable: true, enumerable: false });
    for (const key of Object.keys(value)) {
      (clone as unknown as Record<string, unknown>)[key] = maskDeep(masker, (value as unknown as Record<string, unknown>)[key], depth + 1, seen);
    }
    if (value.cause !== undefined) clone.cause = maskDeep(masker, value.cause, depth + 1, seen);
    return clone;
  }
  if (Array.isArray(value)) return value.map((v) => maskDeep(masker, v, depth + 1, seen));
  if (value instanceof Date || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
  if (value instanceof Map || value instanceof Set) return maskDeep(masker, [...value], depth + 1, seen);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = maskDeep(masker, v, depth + 1, seen);
  return out;
}

export function createLogger(masker: Masker, opts: CreateLoggerOptions = {}): Logger {
  const options: PinoLoggerOptions = {
    level: opts.level ?? 'info',
    hooks: {
      logMethod(args, method) {
        const masked = args.map((a) => maskDeep(masker, a)) as unknown as Parameters<LogFn>;
        method.apply(this, masked);
      },
      streamWrite: (line) => masker.mask(line),
    },
    formatters: {
      log: (obj) => maskDeep(masker, obj) as Record<string, unknown>,
      bindings: (bindings) => maskDeep(masker, bindings) as Record<string, unknown>,
    },
  };
  if (opts.name !== undefined) options.name = opts.name;
  if (opts.base !== undefined) options.base = opts.base;
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

export type { Logger };
