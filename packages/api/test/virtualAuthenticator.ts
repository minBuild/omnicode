/**
 * 테스트용 소프트웨어 인증기 (설계 0002 10장). ES256 키로 `none` 증명 등록 응답과 서명 응답을 만든다.
 * 브라우저 없이 @simplewebauthn/server 의 실제 검증을 통과시키기 위한 것이다.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** 필요한 만큼만 구현한 CBOR 인코더 (정수, 바이트열, 문자열, 배열, 맵) */
export function encodeCbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(encodeCbor(k), encodeCbor(val));
  return Buffer.concat(parts);
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

interface StoredCredential {
  id: string;
  privateKey: KeyObject;
  counter: number;
  userHandle: string;
}

export interface CreationOptionsLike {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string };
}
export interface RequestOptionsLike {
  challenge: string;
  rpId?: string;
  allowCredentials?: Array<{ id: string }>;
}

export interface AuthenticatorTweaks {
  /** 사용자 검증(UV) 플래그. 기본 true */
  uv?: boolean;
  /** clientDataJSON 의 origin 을 바꿔 피싱 시뮬레이션 */
  origin?: string;
  /** 다른 challenge 로 서명 */
  challenge?: string;
  /** 서명할 자격 ID (없으면 첫 번째) */
  credentialId?: string;
  /** 응답에 넣을 userHandle (없으면 등록 때 값) */
  userHandle?: string;
}

export class VirtualAuthenticator {
  readonly credentials: StoredCredential[] = [];
  constructor(
    readonly origin: string,
    /** 동기화 패스키(BE·BS 플래그)처럼 보일지 */
    private readonly synced = true,
  ) {}

  register(options: CreationOptionsLike, tweaks: AuthenticatorTweaks = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = encodeCbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );
    const credId = randomBytes(16);
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    const flags = 0x01 | (tweaks.uv === false ? 0 : 0x04) | (this.synced ? 0x08 | 0x10 : 0) | 0x40;
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([flags]),
      Buffer.alloc(4), // signCount 0
      Buffer.alloc(16), // AAGUID
      Buffer.from([0, credId.length]),
      credId,
      cose,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: tweaks.challenge ?? options.challenge, origin: tweaks.origin ?? this.origin, crossOrigin: false }),
    );
    const attestationObject = encodeCbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const id = b64u(credId);
    this.credentials.push({ id, privateKey, counter: 0, userHandle: options.user.id });
    return {
      id,
      rawId: id,
      type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  assert(options: RequestOptionsLike, tweaks: AuthenticatorTweaks = {}) {
    const cred = tweaks.credentialId
      ? this.credentials.find((c) => c.id === tweaks.credentialId)
      : this.credentials.find((c) => !options.allowCredentials?.length || options.allowCredentials.some((a) => a.id === c.id));
    if (!cred) throw new Error('virtual authenticator: no matching credential');
    cred.counter += 1;
    const rpId = options.rpId ?? new URL(this.origin).hostname;
    const flags = 0x01 | (tweaks.uv === false ? 0 : 0x04) | (this.synced ? 0x08 | 0x10 : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(cred.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), counter]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: tweaks.challenge ?? options.challenge, origin: tweaks.origin ?? this.origin, crossOrigin: false }),
    );
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), cred.privateKey);
    return {
      id: cred.id,
      rawId: cred.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: tweaks.userHandle ?? cred.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
