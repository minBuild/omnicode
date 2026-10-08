/**
 * AWS Secrets Manager SecretStore (운영 기본). 이름은 `<prefix>/...` 로 한정해 IAM 범위(`omnicode/*`) 밖을 건드리지 않는다.
 * - get: GetSecretValue (없으면 undefined)
 * - put: PutSecretValue, 없으면 CreateSecret (경쟁 시 다시 Put)
 * - delete: DeleteSecret + ForceDeleteWithoutRecovery (D13: 유예 없이 즉시 삭제, 없으면 조용히 성공)
 */
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  type CreateSecretCommandOutput,
  type DeleteSecretCommandOutput,
  type GetSecretValueCommandOutput,
  type PutSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';
import type { SecretStore, SecretValue } from '../contracts.js';

/** 테스트에서 가짜 클라이언트를 주입할 수 있도록 send 만 요구한다. */
export interface SecretsManagerLike {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
  send(command: PutSecretValueCommand): Promise<PutSecretValueCommandOutput>;
  send(command: CreateSecretCommand): Promise<CreateSecretCommandOutput>;
  send(command: DeleteSecretCommand): Promise<DeleteSecretCommandOutput>;
}

export interface AwsSecretStoreOptions {
  client?: SecretsManagerLike;
  /** OMNICODE_SECRETS_PREFIX. 모든 ref 는 `${prefix}/` 로 시작해야 한다 */
  prefix: string;
  region?: string;
}

function awsErrorName(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const name = (e as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

export function createAwsSecretStore(opts: AwsSecretStoreOptions): SecretStore {
  const prefix = opts.prefix.replace(/\/+$/, '');
  if (!prefix) throw new TypeError('secrets prefix must not be empty');
  let client: SecretsManagerLike | undefined = opts.client;
  const getClient = (): SecretsManagerLike => {
    client ??= new SecretsManagerClient(opts.region ? { region: opts.region } : {});
    return client;
  };
  const assertRef = (ref: string): void => {
    if (!ref.startsWith(prefix + '/') || ref.length <= prefix.length + 1) throw new TypeError(`secret ref ${JSON.stringify(ref)} is outside prefix ${prefix}/`);
  };

  return {
    async get<T extends SecretValue = SecretValue>(ref: string): Promise<T | undefined> {
      assertRef(ref);
      let out: GetSecretValueCommandOutput;
      try {
        out = await getClient().send(new GetSecretValueCommand({ SecretId: ref }));
      } catch (e) {
        if (awsErrorName(e) === 'ResourceNotFoundException') return undefined;
        throw e;
      }
      const text = out.SecretString ?? (out.SecretBinary ? Buffer.from(out.SecretBinary).toString('utf8') : undefined);
      if (text === undefined) return undefined;
      return JSON.parse(text) as T;
    },

    async put(ref, value) {
      assertRef(ref);
      const SecretString = JSON.stringify(value);
      const c = getClient();
      try {
        await c.send(new PutSecretValueCommand({ SecretId: ref, SecretString }));
        return;
      } catch (e) {
        if (awsErrorName(e) !== 'ResourceNotFoundException') throw e;
      }
      try {
        await c.send(
          new CreateSecretCommand({
            Name: ref,
            SecretString,
            Description: 'OmniCode MCP Hub secret (managed; do not edit by hand)',
            Tags: [{ Key: 'omnicode', Value: prefix }],
          }),
        );
      } catch (e) {
        // 같은 이름이 그 사이 만들어졌으면 (경쟁) 값만 다시 넣는다
        if (awsErrorName(e) !== 'ResourceExistsException') throw e;
        await c.send(new PutSecretValueCommand({ SecretId: ref, SecretString }));
      }
    },

    async delete(ref) {
      assertRef(ref);
      try {
        await getClient().send(new DeleteSecretCommand({ SecretId: ref, ForceDeleteWithoutRecovery: true }));
      } catch (e) {
        if (awsErrorName(e) !== 'ResourceNotFoundException') throw e;
      }
    },
  };
}
