/** 메모리 SecretStore — 테스트·일회성 실행용. 값은 복사해 보관해 호출자와 공유되지 않는다. */
import type { SecretStore, SecretValue } from '../contracts.js';

export interface MemorySecretStore extends SecretStore {
  /** 테스트 검증용 스냅샷 (복사본) */
  snapshot(): Record<string, SecretValue>;
}

export function createMemorySecretStore(initial: Record<string, SecretValue> = {}): MemorySecretStore {
  const map = new Map<string, SecretValue>();
  for (const [k, v] of Object.entries(initial)) map.set(k, structuredClone(v));
  return {
    async get<T extends SecretValue = SecretValue>(ref: string): Promise<T | undefined> {
      const v = map.get(ref);
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    async put(ref, value) {
      map.set(ref, structuredClone(value));
    },
    async delete(ref) {
      map.delete(ref);
    },
    snapshot: () => Object.fromEntries([...map].map(([k, v]) => [k, structuredClone(v)])),
  };
}
