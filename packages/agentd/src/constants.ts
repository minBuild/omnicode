/** 요청·응답 한 줄의 최대 길이 (서버는 거부, 클라이언트는 보내기 전에 검사) */
export const MAX_LINE_BYTES = 1024 * 1024;
/** 소켓 파일의 그룹 기본값 (설계 8.2: `omniagent:omnicode` 0660) */
export const DEFAULT_SOCKET_GROUP = 'omnicode';
/** 클라이언트 요청 제한 시간 기본값 */
export const DEFAULT_CLIENT_TIMEOUT_MS = 60_000;
