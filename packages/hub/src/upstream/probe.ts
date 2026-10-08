/**
 * 업스트림 세대 감지 — 설계문서 11.1.
 *
 * 1. `server/discover`를 modern 헤더로 POST.
 *    - 200 + 결과 → modern. 지원 버전 목록을 저장한다.
 *    - 400 + modern JSON-RPC 오류(UnsupportedProtocolVersion의 `data.supported`, HeaderMismatch -32020) → modern.
 *      오류가 알려 준 버전으로 다시 discover 한다.
 *    - 401 → UpstreamError('unauthorized', { wwwAuthenticate }). 호출자가 인증을 해결하고 다시 probe 한다.
 *    - 그 밖의 4xx/5xx 또는 modern 오류가 아닌 본문 → 2.
 * 2. SDK로 `initialize` (2025-11-25 요청, 아래 버전으로 협상) → legacy.
 * 3. 실패하면 HTTP+SSE(2024-11-05): GET으로 `endpoint` 이벤트 → legacy, 전송 `sse`.
 * 4. 모두 실패 → UpstreamError('unavailable').
 */
import { LIMITS, isModernProtocolVersion } from '@omnicode/shared';
import { UpstreamError, type ProbeResult, type UpstreamConnectorOptions } from '../contracts.js';
import {
  abortErrorFrom,
  advertisedVersionsOf,
  createRequestClock,
  describeError,
  insufficientScopeError,
  isModernJsonRpcError,
  protocolError,
  unauthorizedError,
  unavailableError,
  type JsonRpcErrorObject,
} from './common.js';
import { openLegacySessionWithFallback, resolveTimeouts, type LegacySession, type LegacyTransportKind } from './legacy.js';
import { MODERN_PROTOCOL_VERSION, modernPost, parseDiscoverResult, type DiscoverInfo, type ModernPostOutcome } from './modern.js';

export type Detection =
  | { era: 'modern'; result: ProbeResult; discover: DiscoverInfo }
  | { era: 'legacy'; result: ProbeResult; session: LegacySession };

export interface DetectOptions {
  signal?: AbortSignal | undefined;
  /** legacy 전송을 강제 (저장된 probe 결과로 재연결할 때) */
  legacyTransport?: LegacyTransportKind | undefined;
}

/**
 * 세대를 감지한다. legacy면 initialize까지 마친 세션을 함께 돌려주므로, 쓰지 않을 때는 호출자가 닫아야 한다.
 */
export async function detectEra(opts: UpstreamConnectorOptions, o: DetectOptions = {}): Promise<Detection> {
  const timeouts = resolveTimeouts(opts.timeouts);
  const modern = await probeModern(opts, timeouts.initializeMs, o.signal);
  if (modern) return modern;
  const session = await openLegacySessionWithFallback(opts, { timeoutMs: timeouts.initializeMs, signal: o.signal, transport: o.legacyTransport });
  opts.logger?.debug({ serverId: opts.serverId, transport: session.kind, version: session.probe.protocolVersion }, 'upstream detected as legacy');
  return { era: 'legacy', result: session.probe, session };
}

function modernDetection(discover: DiscoverInfo): Detection {
  return {
    era: 'modern',
    discover,
    result: {
      era: 'modern',
      protocolVersion: discover.protocolVersion,
      transport: 'streamable_http',
      serverInfo: discover.serverInfo,
      capabilities: discover.capabilities,
      ...(discover.instructions !== undefined ? { instructions: discover.instructions } : {}),
    },
  };
}

/** 1단계. modern이 아니라고 판단되면 undefined (→ 2단계). */
async function probeModern(opts: UpstreamConnectorOptions, timeoutMs: number, signal: AbortSignal | undefined): Promise<Detection | undefined> {
  const discover = async (version: string): Promise<ModernPostOutcome | undefined> => {
    const clock = createRequestClock({ signal, totalMs: timeoutMs });
    try {
      return await modernPost({
        fetch: opts.fetch,
        url: opts.url,
        headers: opts.headers,
        protocolVersion: version,
        id: 1,
        method: 'server/discover',
        params: {},
        clientCapabilities: {},
        signal: clock.signal,
        maxBytes: LIMITS.toolsListBytes,
      });
    } catch (e) {
      if (clock.timedOut) throw new UpstreamError('timeout', `server/discover did not answer within ${timeoutMs}ms`);
      if (clock.cancelled) throw abortErrorFrom(clock.signal);
      // 200인데 JSON-RPC가 아닌 본문(HTML 등) → modern 아님
      if (e instanceof UpstreamError && e.kind === 'protocol') return undefined;
      if (e instanceof UpstreamError) throw e;
      throw unavailableError(`cannot reach upstream: ${describeError(e)}`);
    } finally {
      clock.dispose();
    }
  };

  const first = await discover(MODERN_PROTOCOL_VERSION);
  if (!first) return undefined;
  if (first.kind === 'result') return modernDetection(parseDiscoverResult(first.result, MODERN_PROTOCOL_VERSION));

  let modernError: JsonRpcErrorObject | undefined;
  if (first.kind === 'rpc_error') {
    if (!isModernJsonRpcError(first.error)) return undefined;
    modernError = first.error;
  } else {
    if (first.status === 401) throw unauthorizedError(first.wwwAuthenticate, 'upstream requires authentication');
    if (first.status === 403) {
      const scoped = insufficientScopeError(first.wwwAuthenticate);
      if (scoped) throw scoped;
      return undefined;
    }
    if (!first.rpcError || !isModernJsonRpcError(first.rpcError)) return undefined;
    modernError = first.rpcError;
  }

  // modern 오류를 받았다. 알려 준 버전 중 우리가 말할 수 있는 가장 높은 것으로 다시 묻는다.
  const advertised = advertisedVersionsOf(modernError).filter(isModernProtocolVersion).sort().reverse();
  if (advertised.length === 0) {
    if (modernError.code === -32020) {
      // HeaderMismatch: 우리 요청을 modern 형식으로 읽었다는 뜻 → modern. serverInfo는 아직 모른다.
      opts.logger?.warn({ serverId: opts.serverId, error: modernError }, 'upstream answered server/discover with HeaderMismatch');
      return modernDetection({ protocolVersion: MODERN_PROTOCOL_VERSION, protocolVersions: [], serverInfo: null, capabilities: null });
    }
    // modern 오류 형식이지만 legacy 버전만 지원 → initialize로
    return undefined;
  }
  const version = advertised.includes(MODERN_PROTOCOL_VERSION) ? MODERN_PROTOCOL_VERSION : (advertised[0] as string);
  opts.logger?.debug({ serverId: opts.serverId, version, advertised }, 'upstream is modern; retrying server/discover with advertised version');
  const second = await discover(version);
  if (!second) throw protocolError({ code: -32603, message: 'upstream sent a malformed server/discover response' });
  if (second.kind === 'result') {
    const info = parseDiscoverResult(second.result, version);
    if (info.protocolVersions.length === 0) info.protocolVersions = advertised;
    return modernDetection(info);
  }
  if (second.kind === 'rpc_error') throw protocolError(second.error, second.status);
  if (second.status === 401) throw unauthorizedError(second.wwwAuthenticate, 'upstream requires authentication');
  if (second.rpcError) throw protocolError(second.rpcError, second.status);
  throw unavailableError(`server/discover failed with HTTP ${second.status}`, second.status);
}
