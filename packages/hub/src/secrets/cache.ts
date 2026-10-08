/**
 * 프로세스 메모리 캐시 (16.6: 서버당 1개, 디스크 캐시 없음). write-through:
 * put/delete 는 먼저 원본 저장소에 쓰고 나서 캐시를 갱신한다. get 은 캐시를 먼저 본다 (미스는 캐시하지 않는다).
 */
import type { SecretStore, SecretValue } from '../contracts.js';

export interface CachedSecretStore extends SecretStore {
  /** ref 하나(또는 전부)를 캐시에서 비운다 — 외부에서 시크릿이 바뀌었을 때 */
  invalidate(ref?: string): void;
  /** 캐시 적중 여부 (테스트·상태 표시용) */
  has(ref: string): boolean;
}

export function withCache(store: SecretStore): CachedSecretStore {
  const cache = new Map<string, SecretValue>();
  const inflight = new Map<string, Promise<SecretValue | undefined>>();

  return {
    async get<T extends SecretValue = SecretValue>(ref: string): Promise<T | undefined> {
      const hit = cache.get(ref);
      if (hit !== undefined) return structuredClone(hit) as T;
      let p = inflight.get(ref);
      if (!p) {
        p = store
          .get(ref)
          .then((v) => {
            if (v !== undefined) cache.set(ref, structuredClone(v));
            return v;
          })
          .finally(() => inflight.delete(ref));
        inflight.set(ref, p);
      }
      const v = await p;
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    async put(ref, value) {
      await store.put(ref, value);
      cache.set(ref, structuredClone(value));
    },
    async delete(ref) {
      await store.delete(ref);
      cache.delete(ref);
    },
    invalidate(ref) {
      if (ref === undefined) cache.clear();
      else cache.delete(ref);
    },
    has: (ref) => cache.has(ref),
  };
}
