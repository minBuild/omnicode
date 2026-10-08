/**
 * SecretsFacade — SecretStore 위에서 읽고 쓰는 모든 비밀 문자열(토큰·키·client_secret·Hub 토큰)을
 * 마스킹 사전(16.6)에 넣는다. 로그·이벤트·감사 로그·오류 메시지는 이 마스커로 가린다.
 * 삭제해도 사전에서 빼지 않는다 — 진행 중이던 요청의 오류 메시지에 옛 값이 남을 수 있기 때문.
 */
import type { Masker } from '@omnicode/shared';
import type { SecretStore, SecretValue } from '../contracts.js';

export interface SecretsFacade extends SecretStore {
  readonly masker: Masker;
  readonly store: SecretStore;
  /** 값 안의 비밀 문자열을 마스커에 등록한다 (get/put 이 자동으로 부른다) */
  remember(value: SecretValue | undefined): void;
}

/** 타입별 비밀 필드만 뽑는다. issuer·client_id·scope·시각 같은 비밀 아닌 값은 제외한다. */
export function secretStringsOf(value: SecretValue): string[] {
  const out: string[] = [];
  const push = (s: unknown) => {
    if (typeof s === 'string' && s.length > 0) out.push(s);
  };
  if ('type' in value) {
    switch (value.type) {
      case 'header': {
        push(value.value);
        // "Bearer xyz" 같은 값은 업스트림 오류 메시지에 토큰만 섞여 나올 수 있으니 토큰 부분도 등록한다
        const m = /^\s*(?:Bearer|Basic|Token|ApiKey)\s+(\S+)\s*$/i.exec(value.value ?? '');
        if (m) push(m[1]);
        break;
      }
      case 'oauth':
        push(value.client_secret);
        push(value.registration_access_token);
        push(value.access_token);
        push(value.refresh_token);
        break;
      case 'stdio_env':
        for (const v of Object.values(value.env ?? {})) push(v);
        break;
    }
    return out;
  }
  // HubTokensSecret
  push(value.claude);
  push(value.codex);
  push(value.gemini);
  return out;
}

export function createSecretsFacade(store: SecretStore, masker: Masker): SecretsFacade {
  const remember = (value: SecretValue | undefined): void => {
    if (!value) return;
    for (const s of secretStringsOf(value)) masker.add(s);
  };
  return {
    masker,
    store,
    remember,
    async get<T extends SecretValue = SecretValue>(ref: string): Promise<T | undefined> {
      const v = await store.get<T>(ref);
      remember(v);
      return v;
    },
    async put(ref, value) {
      remember(value); // 저장이 실패해도 값이 오류 메시지에 섞일 수 있으니 먼저 등록
      await store.put(ref, value);
    },
    delete: (ref) => store.delete(ref),
  };
}
