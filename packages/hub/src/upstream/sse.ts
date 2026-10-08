/**
 * SSE 응답 본문 읽기 — `eventsource-parser`로 이벤트를 뽑고, 읽은 바이트 수를 제한한다.
 * 주석(`: keepalive`)은 파서가 이벤트로 올리지 않으므로 자연히 무시된다.
 */
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { UpstreamError } from '../contracts.js';

export interface ReadSseOptions {
  /** 스트림 전체에서 읽을 최대 바이트. 넘으면 UpstreamError('too_large') */
  maxBytes?: number;
  /** 이벤트마다 호출. 'stop'을 돌려주면 나머지를 버리고 끝낸다 */
  onEvent: (event: EventSourceMessage) => void | 'stop';
}

export async function readSseStream(body: ReadableStream<Uint8Array> | null, opts: ReadSseOptions): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let stop = false;
  let total = 0;
  const parser = createParser({
    onEvent: (event) => {
      if (stop) return;
      if (opts.onEvent(event) === 'stop') stop = true;
    },
  });
  try {
    while (!stop) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (opts.maxBytes !== undefined && total > opts.maxBytes) {
        throw new UpstreamError('too_large', `upstream SSE stream exceeded ${opts.maxBytes} bytes`);
      }
      parser.feed(decoder.decode(value, { stream: true }));
    }
    if (!stop) {
      // 끝에 빈 줄 없이 닫힌 마지막 이벤트를 흘려보낸다
      parser.feed(decoder.decode());
      parser.reset({ consume: true });
    }
  } finally {
    if (stop) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
}

/** 응답 본문을 바이트 제한 안에서 전부 읽는다. 넘으면 UpstreamError('too_large'). */
export async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new UpstreamError('too_large', `upstream response declared ${declared} bytes (limit ${maxBytes})`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new UpstreamError('too_large', `upstream response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    if (total > maxBytes) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
