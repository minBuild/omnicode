/**
 * 패스키 흐름 (설계 0002 5장). 브라우저 WebAuthn 호출은 @simplewebauthn/browser 가 한다.
 * 순수 함수(safeNextPath, guessDeviceLabel, isCeremonyCancelled)는 node 테스트가 가능하다.
 */
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { authApi } from '../api/auth';

export async function loginWithPasskey(): Promise<void> {
  const { challengeId, options } = await authApi.loginOptions();
  const response = await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
  await authApi.loginVerify({ challengeId, response });
}

export async function reauthWithPasskey(): Promise<string> {
  const { challengeId, options } = await authApi.reauthOptions();
  const response = await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
  return (await authApi.reauthVerify({ challengeId, response })).recentAuthUntil;
}

export async function setupWithPasskey(setupToken: string, label: string): Promise<void> {
  const token = setupToken.trim();
  const { challengeId, options } = await authApi.setupOptions(token);
  const response = await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
  await authApi.setupVerify({ setupToken: token, challengeId, response, label });
}

export async function addPasskey(label: string) {
  const { challengeId, options } = await authApi.addPasskeyOptions();
  const response = await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
  return authApi.addPasskeyVerify({ challengeId, response, label });
}

/** 사용자가 패스키 창을 닫았거나 시간이 지나 취소된 경우. 오류로 보여주지 않는다 */
export function isCeremonyCancelled(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return e.name === 'NotAllowedError' || e.name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED';
}

/** 로그인 뒤 돌아갈 경로. 같은 사이트의 절대 경로만 허용한다 (오픈 리다이렉트 방지) */
export function safeNextPath(raw: string | null | undefined, fallback = '/mcp'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  if (raw.startsWith('/login') || raw.startsWith('/setup')) return fallback;
  if (/[\u0000-\u001f]/.test(raw)) return fallback;
  return raw;
}

/** 패스키 이름 기본값 — 사용자가 고칠 수 있다 */
export function guessDeviceLabel(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'Mac';
  if (/Windows/.test(userAgent)) return 'Windows';
  if (/Linux/.test(userAgent)) return 'Linux';
  return '이 기기';
}

/** 세션 목록에 보여줄 짧은 브라우저 설명 */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return '알 수 없는 기기';
  const device = guessDeviceLabel(userAgent);
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /CriOS|Chrome\//.test(userAgent)
      ? 'Chrome'
      : /FxiOS|Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : '브라우저';
  return `${device} · ${browser}`;
}
