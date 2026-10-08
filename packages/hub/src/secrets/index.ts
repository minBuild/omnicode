/** secrets — 10.6 시크릿 저장소 (AWS | file | memory) + 캐시 + 마스킹 파사드. */
import path from 'node:path';
import type { Masker } from '@omnicode/shared';
import type { HubConfig, SecretStore } from '../contracts.js';
import { createAwsSecretStore, type SecretsManagerLike } from './aws.js';
import { withCache } from './cache.js';
import { createSecretsFacade, type SecretsFacade } from './facade.js';
import { createFileSecretStore } from './file.js';
import { createMemorySecretStore } from './memory.js';

export { createAwsSecretStore } from './aws.js';
export type { AwsSecretStoreOptions, SecretsManagerLike } from './aws.js';
export { withCache } from './cache.js';
export type { CachedSecretStore } from './cache.js';
export { createSecretsFacade, secretStringsOf } from './facade.js';
export type { SecretsFacade } from './facade.js';
export { createFileSecretStore, secretFilePath } from './file.js';
export { createMemorySecretStore } from './memory.js';
export type { MemorySecretStore } from './memory.js';

export type SecretsConfig = Pick<HubConfig, 'secretsBackend' | 'secretsPrefix' | 'dataDir'> & Partial<Pick<HubConfig, 'fileSecretsDir'>>;

export function createBackendStore(config: SecretsConfig, opts: { awsClient?: SecretsManagerLike } = {}): SecretStore {
  switch (config.secretsBackend) {
    case 'aws':
      return createAwsSecretStore({ prefix: config.secretsPrefix, client: opts.awsClient });
    case 'file':
      return createFileSecretStore(config.fileSecretsDir ?? path.join(config.dataDir, 'secrets'));
    case 'memory':
      return createMemorySecretStore();
  }
}

/** 설정에 맞는 백엔드 + 캐시 + 마스킹 파사드를 한 번에 만든다 (조립 계층용). */
export function createSecretsForConfig(config: SecretsConfig, masker: Masker, opts: { awsClient?: SecretsManagerLike } = {}): SecretsFacade {
  return createSecretsFacade(withCache(createBackendStore(config, opts)), masker);
}
