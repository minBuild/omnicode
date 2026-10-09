# 0001 MCP 화면 관리 — 남은 작업 인수인계

| 항목 | 내용 |
|---|---|
| 기준 커밋 | `2e4b8ff` (2026-10-08, main) — 진행 현황은 아래 표 |
| 설계문서 | [`docs/design/0001-mcp-management.md`](../design/0001-mcp-management.md) — 장 번호는 모두 이 문서 기준 |
| 대상 | 이 문서만 읽고 바로 이어서 작업할 구현자 (사람 또는 코딩 에이전트) |

## 진행 현황 (2026-10-08 갱신)

| 항목 | 상태 | 커밋 |
|---|---|---|
| A1 운영 인증 | **완료** — 설계 [0002](../design/0002-auth.md), 패스키 로그인·세션·재인증, 화면 | `1389f77`, `bd642aa` |
| A2 Phase 0 검증 (P2~P10, P12) | 남음 — 실제 CLI·EC2·폰 필요 | — |
| A3 수용 테스트 | 남음 — A2 뒤 | — |
| A4 실제 배포 | 남음 — 설치 스크립트는 정적 검사·스텁 실행까지만 검증 | — |
| D1 업스트림 로그 전달 | **완료** (마스킹, 수준 필터, legacy 는 AsyncLocalStorage 로 호출에 귀속) | `23e3876` |
| D2 OAuth 폴백 | **완료** | `635cf7e` |
| D3 SSE 도구 호출 테스트 | **완료** (SSE 경로 버그 2건 수정, 테스트는 `legacy-sse.test.ts`) | `8f10f7f` |
| D4 Claude 어댑터 재검증 | **완료** | `6868b11` |
| D5 API 다듬기 | **완료** (Fastify 4xx 코드, `OMNICODE_WEB_LIVE`, 인증 훅 `onRequest`) | `1389f77` |
| D6 웹 DOM 테스트 | **완료** (vitest `web-dom` 프로젝트, jsdom) | `bd642aa` |
| D7 agentd 소켓 활성화 | **완료** | `a794cf4` |
| D8 상태 점검 | **완료** + 버그 수정: 점검·`list_changed`가 진행 중 호출을 끊던 문제 | `23e3876` |
| D9 계약 확장 | **완료** | `23e3876` |
| D10 modern 다운스트림 | 보류 — SDK 1.32.1 이 아직 2026-07-28 미지원 (2026-10-08 확인) | — |
| C1 stdio 샌드박스 | **보류** — 이 환경에 Docker 데몬이 없어 격리 경계를 검증할 수 없고, 네트워크 정책(설계 미결 6)이 열려 있다. 아래 C1 에 구체적 제안 | — |
| C2 JSON 붙여넣기 | **완료** (원격 항목. stdio 는 C1 뒤) + 버그 수정: 실패 뒤 마법사 입력이 지워지던 문제 | 아래 커밋 |
| C3 리소스 구독 전달 | **완료** + 버그 수정: modern `subscriptions/listen` 요청 형식이 스펙과 달랐음 (D24) | 아래 커밋 |
| C4 프리셋 기여 운영 | 남음 — 외부 PR 이 있어야 한다 | — |
| D 레지스트리 검색 | **완료** — `OMNICODE_MCP_REGISTRY_URL` 을 설정했을 때만 켜진다 (기본 소스 결정은 설계 미결 5) | 아래 커밋 |
| D 실행 단위 주입 (12.8) | 남음 — CLI 별 `--mcp-config` 류 지원을 P2~P4 에서 확인해야 한다 | — |
| D 화면 elicitation (11.4) | 남음 — 폰 알림·대기 시간 같은 UX 결정이 먼저다 | — |
| D tasks 확장 | 남음 — 공식 확장 스펙이 다운스트림 CLI 에 쓰이는지부터 확인 | — |
| D 통합 엔드포인트 (미결 1) | 남음 — P2~P4 의 `list_changed` 지원 결과에 달려 있다 | — |

이번 작업에서 새로 알게 된 것 (설계 0001 19.2.1·20장에 반영):

- **Tailscale 전용 배포와 CIMD.** session 인증에 공개 URL이 필수라 tailnet 배포도 `ts.net` 주소를 갖는다. 인가 서버가 그 CIMD 문서를 가져갈 수 없으므로 `OMNICODE_OAUTH_CIMD=0`을 추가했다.
- **SSE 스트림 유실 (미해결).** HTTP+SSE 업스트림이 스트림을 닫으면 진행 중 호출은 유휴 타임아웃(기본 5분)까지 기다리고, SDK가 `initialize` 없이 새 세션으로 조용히 다시 붙는다. `onClose`도 오지 않는다. 엄격한 서버는 그 세션을 거부할 수 있다. 커넥터 풀 복구 방식을 바꿔야 해서 설계 판단이 먼저다.
- **세션 열기 중 취소.** 두 전송 모두 세션을 여는 동안에는 `ctx.signal` 취소를 따르지 않는다 (SSE 는 이제 시간 상한은 있다).
- **Linux 의 fd 3.** agentd 가 띄우는 CLI 에 상속된 fd 3 이 넘어갈 수 있다 (Node 가 close-on-exec 를 걸 수 없다). `LISTEN_*` 는 지우므로 해는 없지만 Linux 에서 확인하지 못했다.
- **systemd 유닛 검증.** `systemd-analyze verify`를 돌리지 못했다 (로컬에 systemd 없음). A4 때 확인한다.

---

## 0. 먼저 알아야 할 것

### 0.1 저장소 규칙

- **커밋에 Claude 서명을 넣지 않는다.** `Co-Authored-By`, `Claude-Session` 같은 꼬리말 금지. 작성자는 저장소의 git 설정(minBuild)을 그대로 쓴다.
- 커밋은 작업 단위로 나눈다. 제목은 `feat(hub): …`, `fix: …`, `docs: …`, `chore(infra): …` 형식, 본문은 한국어로 왜·무엇을 바꿨는지.
- 코드 주석은 한국어, 설계문서 장 번호를 가리킨다 (예: `// 11.8 정책`).
- 테스트 없는 변경은 받지 않는다. `packages/*/test` 에 vitest 로 추가한다.
- `packages/hub/src/contracts.ts` 는 모듈 간 계약이다. 바꾸면 영향 받는 구현·가짜(fake)·테스트를 같은 커밋에서 고친다.
- `packages/shared` 는 모든 패키지가 의존한다. 런타임 코드를 web 에서 import 하지 않는다 (`import type` 만).

### 0.2 검증 명령 (전부 통과한 상태에서 시작한다)

```bash
npm install
npx tsc -b                               # 타입 검사 (web 제외)
npx vitest run                           # 55 파일 / 674 테스트 (node + web-dom 프로젝트)
npm run build                            # tsc + 마이그레이션 .sql 복사
npm run build --workspace @omnicode/web  # Vite 빌드 (인라인 스크립트 없어야 함)
npm run validate:presets
npm test --workspace @omnicode/tools
```

로컬 스모크 (AWS·CLI 없이):

```bash
export HOME=/tmp/omni-dev/home OMNICODE_SECRETS_BACKEND=memory OMNICODE_DATA_DIR=/tmp/omni-dev/data \
  OMNICODE_AGENTD_SOCKET=/tmp/omni-dev/agentd.sock OMNICODE_DEV_TOKEN=dev-token-change-me-please \
  OMNICODE_MCP_ALLOW_HTTP_LOOPBACK=1 OMNICODE_PUBLIC_URL=https://omni.example
mkdir -p $HOME && node packages/agentd/dist/main.js & node packages/api/dist/main.js
curl -s -H "Authorization: Bearer $OMNICODE_DEV_TOKEN" http://127.0.0.1:8080/api/mcp/hub/status
```

### 0.3 코드 지도

| 위치 | 역할 | 테스트 |
|---|---|---|
| `packages/shared/src` | 타입·zod 스키마·오류 코드(11.9, 14.3)·JCS 해시·마스킹·agentd 프로토콜 | `packages/shared/test` |
| `packages/hub/src/contracts.ts` | 모듈 계약 (Registry, SecretStore, UpstreamConnector, OAuthManager, Hub 파사드) | — |
| `packages/hub/src/net` | guardedFetch (16.2) | `test/net` + `test/fixtures/ssrf-corpus.json` |
| `packages/hub/src/registry` | node:sqlite, 마이그레이션, 9.2 전이표 | `test/registry` |
| `packages/hub/src/secrets` | aws / file / memory 저장소, 캐시, 마스킹 연동 | `test/secrets` |
| `packages/hub/src/upstream` | legacy(SDK)·modern(자체) 커넥터, 세대 감지 (11.1) | `test/upstream`, `test/fixtures/upstream-*.ts` |
| `packages/hub/src/oauth` | 탐색·등록·PKCE·iss·refresh 단일 비행·step-up (10장) | `test/oauth`, `test/fixtures/fake-as.ts` |
| `packages/hub/src/downstream` | 에이전트용 MCP 서버: 토큰, 11.8 정책, progress, 알림, 감사 | `test/downstream` |
| `packages/hub/src/services` | 서버 파사드(추가·승인·삭제), 동기화, 토큰, 커넥터 풀, 훅, DTO | `test/services`, `test/hub.integration.test.ts` |
| `packages/hub/src/hub.ts` | `createHub` 조립 루트 | `test/hub.integration.test.ts` |
| `packages/agentd/src` | omniagent 데몬, Claude·Codex·Gemini 어댑터, 토큰 파일 | `packages/agentd/test` |
| `packages/api/src` | Fastify 라우트(14장), CIMD, 콜백 페이지, 인증 훅(개발용) | `packages/api/test` (`fakeHub.ts`) |
| `packages/web/src` | 화면 6종 (15장) | `packages/web/test` (DOM 없음) |
| `infra/`, `presets/`, `scripts/` | systemd·iptables·백업·설치·배포, 프리셋 검증, CI | `packages/tools/test/headers.test.sh` |

---

## 1. 우선순위 A — 출시 전 필수

### A1. 운영 인증 훅 (설계 8.3, 16.1)

**현재:** `packages/api/src/auth.ts` 에 `AuthHooks` 인터페이스(`requireSession`, `requireRecentAuth`, `sessionIdOf`)와 **개발용** `createDevAuthHooks` 만 있다. `OMNICODE_AUTH_MODE=session` 이면 서버가 기동을 거부한다 (`packages/api/src/main.ts`).

**할 일:**
1. OmniCode 전체 인증 설계가 아직 없다. `docs/design/0002-auth.md` 를 먼저 쓴다: 패스키(WebAuthn) 로그인, `__Host-` 세션 쿠키(`Secure`, `HttpOnly`, `SameSite=Lax` — Strict 금지, 10.3 참고), 5분 재인증(step-up), CloudFront 로그인 벽과의 관계, 공개 경로 두 개(`/.well-known/omnicode/client.json`, `/oauth/callback`) 예외.
2. `createSessionAuthHooks(...)` 를 구현해 `AuthHooks` 를 만족시키고, `main.ts` 가 `OMNICODE_AUTH_MODE=session` 에서 이것을 쓰게 한다.
3. 세션 저장소는 레지스트리 SQLite 에 테이블을 추가하거나(마이그레이션 `002_*.sql`) 별도 파일 DB.
4. 테스트: `packages/api/test/auth.test.ts` 에 세션·재인증·만료 케이스 추가. `fakeHub` 는 그대로 쓴다.

**완료 조건:** `OMNICODE_DEV_TOKEN` 없이 `OMNICODE_AUTH_MODE=session` 으로 기동되고, 로그인 없는 요청은 401, 재인증 없는 토큰 재발급은 401 `reauth_required`.

### A2. Phase 0 검증 (설계 19.1) — 실제 CLI·EC2·폰 필요

P1, P11 은 완료. 아래는 각 항목의 **확인 방법**과 **결과에 따라 바꿔야 할 코드**다. 결과는 설계 19.1 표에 "완료 (날짜): …" 로 적고 19.2.1 구현 메모에 반영한다.

| ID | 확인 | 결과에 따라 고칠 곳 |
|---|---|---|
| P2 | 개발 EC2 에서 Hub 에 Claude Code 연결. (a) `claude mcp add-json` 이 기존 이름에 실패하는지 → 어댑터는 remove 후 add 를 가정. (b) user scope `headersHelper` 가 trust 없이 실행되는지. (c) 서버 항목 `timeout` 적용. (d) `~/.claude/settings.json` 의 `permissions.allow: ["mcp__omni-<id>"]` 가 `claude -p` 헤드리스에서 확인 없이 허용하는지. (e) `list_changed` 수신 후 도구 갱신. (f) 보내는 `MCP-Protocol-Version` | `packages/agentd/src/adapters/claude.ts`, 설계 12.3·12.7 |
| P3 | Codex: `bearer_token_env_var`, `env_http_headers` 에서 변수가 비었을 때, `tool_timeout_sec`, 서버 테이블 승인 모드 필드(`default_tools_approval_mode`) 의미, `list_changed`, 세대 | `packages/agentd/src/adapters/codex.ts` — 승인 모드 필드를 확인 뒤 `autoApprove` 에 연결 |
| P4 | Gemini: `headers` 값의 `${VAR}`·`${VAR:-}` 확장, `trust`, `timeout`, `list_changed`, 세대 | `packages/agentd/src/adapters/gemini.ts` |
| P5 | Hub 재시작 후 세 CLI 가 404 를 받고 재초기화하는지 | `packages/hub/src/downstream/server.ts` (세션은 메모리) |
| P6 | 90초 걸리는 가짜 도구로 Claude Code 5분 유휴 타이머가 전달된 progress 로 리셋되는지. 합성 heartbeat(60초) 가 필요한지 | `packages/hub/src/downstream/session.ts` `buildCtx` 의 heartbeat (기본 켬) |
| P7 | Fish Audio 실제 서버: PRM 제공, 인가 서버의 CIMD·DCR, scope, 음성 생성 소요 시간, `list_changed` | `presets/fish-audio.json` 의 `auth.scopes`, 타임아웃 기본값 |
| P8 | CloudFront: 공개 경로 2개, 콜백 쿼리 보존, 로그인 벽이 콜백을 가로채지 않는지, iOS 홈 화면 앱에서 복귀 | `infra/cloudfront/README.md`, A1 |
| P9 | `omniagent` 에서 `curl -X PUT http://169.254.169.254/latest/api/token` 과 `aws sts get-caller-identity` 가 실패 | `infra/bin/omnicode-imds-guard` |
| P10 | Linux 에서 agentd 소켓이 `omnicode` 에서는 열리고 다른 사용자는 거부. `RuntimeDirectory` 소유권 문제는 `SupplementaryGroups=omniagent` 로 우회 중 | `infra/systemd/*.service`, `packages/agentd/src/server.ts` (chgrp 실패는 경고). 깔끔한 해법은 systemd `.socket` 유닛 (아래 D7) |
| P12 | 11.10 크기 제한·11.7 동시성 기본값이 Fish Audio 에 충분한지 | `packages/shared/src/constants.ts` `LIMITS`, `DEFAULTS` |

### A3. 수용 테스트 (설계 19.4, 12개)

A1·A2 뒤에 실제 EC2 + Fish Audio 로 수행한다. 결과를 19.4 아래에 표로 남긴다. 특히 2(세 CLI 헤드리스 호출), 6(바인딩 강제), 8(60초 넘는 호출), 11(토큰 재발급 유예)을 빠뜨리지 않는다.

### A4. 배포 실행

- 새 EC2 에서 `infra/install/mcp-feature.sh` → `infra/bin/omnicode-deploy` 순서로 실제 설치. 설치 스크립트는 로컬에서 `bash -n` 과 함수 단위 테스트만 거쳤다 (실행은 미검증).
- 설치 뒤 `omnicode.service` 첫 기동 로그에 `omnicode hub started` 와 토큰 파일 생성이 보여야 한다.
- IAM 정책(`infra/aws/iam-policy.json`)의 `__OMNICODE_BACKUP_BUCKET__` 치환, CloudFront 동작 추가는 수동이다.

---

## 2. 우선순위 B — 알려진 공백 (코드)

각 항목은 독립적이라 병렬로 나눠 맡길 수 있다.

### D1. 업스트림 `notifications/message` 전달 (설계 11.3)

현재 커넥터가 소비하고 버린다. `contracts.ts` 의 `CallContext` 에 `onMessage?(n: { level, logger?, data }): void` 를 추가하고, `upstream/legacy.ts`·`upstream/modern.ts` 가 요청 스트림 안의 `notifications/message` 를 넘기며, `downstream/session.ts` 가 같은 요청 스트림으로 `sendNotification` 한다. 테스트: `test/upstream`, `test/downstream/server.test.ts` 에 각각 추가. Logging 이 2026-07-28 에서 Deprecated 이므로 기본 켬/끔은 설정값으로.

### D2. OAuth 탐색 폴백 보강 (설계 10.3)

- 메타데이터가 전혀 없는 2025-03-26 이전 서버: 인가 서버 기본 엔드포인트(`/authorize`, `/token`, `/register`) 폴백 미구현 → `packages/hub/src/oauth/discovery.ts`.
- OIDC discovery(`openid-configuration`) 로만 찾은 인가 서버는 SDK 가 `authorization_response_iss_parameter_supported` 와 `revocation_endpoint` 를 버린다 → 원문 JSON 을 한 번 더 읽어 보존. `test/fixtures/fake-as.ts` 에 OIDC 전용 모드 추가.

### D3. HTTP+SSE 레거시 전송의 도구 호출 테스트

`test/fixtures/upstream-legacy-sse.ts` 는 탐지·initialize 만 검증한다. `tools/call`·progress·취소를 추가한다 (`packages/hub/test/upstream/legacy.test.ts`).

### D4. Claude 어댑터 적용 후 재검증

`claude mcp add-json` 뒤 `~/.claude.json` 을 다시 읽어 항목이 실제로 들어갔는지 확인하고, 아니면 `cli_error` 로 보고한다 (`packages/agentd/src/adapters/claude.ts`). P2 결과에 맞춘다.

### D5. API 다듬기

- Fastify 자체 4xx(잘못된 JSON 400, 본문 1 MiB 초과 413, 415) 가 `validation_error` 로 나간다. `API_ERROR_STATUS` 에 맞는 코드를 정하거나 그대로 두되 문서화 (`packages/api/src/errors.ts`).
- 정적 파일이 `wildcard: false` 라 웹을 다시 빌드하면 API 재시작이 필요하다. `omnicode-deploy` 가 재시작하므로 운영에는 문제없지만 개발 편의를 위해 옵션화 검토 (`packages/api/src/routes/spa.ts`).
- 인증 훅이 `preHandler` 라 본문 파싱이 인증보다 먼저다. `onRequest` 로 옮기는 것을 검토 (A1 과 함께).

### D6. 웹 DOM 테스트

jsdom + React Testing Library 로 추가 마법사(승인 단계)와 서버 상세의 핵심 상호작용을 최소 3개 테스트. vitest `environment: 'jsdom'` 은 web 패키지 설정에만 둔다.

### D7. agentd 를 systemd `.socket` 유닛으로

`omnicode-agentd.socket` (`ListenStream=/run/omnicode/agentd.sock`, `SocketUser=omniagent`, `SocketGroup=omnicode`, `SocketMode=0660`) + 소켓 활성화 지원(`packages/agentd/src/server.ts` 에서 `LISTEN_FDS` 처리). 그러면 `SupplementaryGroups=omniagent` 우회와 chgrp 코드가 사라진다. P10 과 함께.

### D8. 상태 점검 최적화 (설계 17.3)

`packages/hub/src/hub.ts` 의 `healthSweep` 이 10분마다 모든 서버의 `tools/list` 를 다시 받는다. modern 응답의 `ttlMs` 가 더 길면 미루고, `error` 서버는 지수 백오프(1분 → 30분)로 재시도한다. 현재 커넥터 풀은 `error` 에서도 즉시 재연결을 시도한다.

### D9. 계약 타입 확장

- `UpstreamConnector.callTool` params 타입을 MRTR 재시도 필드(`inputResponses`, `requestState`)까지 포함하도록 넓힌다 (런타임은 이미 그대로 전달).
- `CallContext` 에 D1 의 `onMessage`.
- 바꾼 뒤 `test/downstream/server.test.ts` 의 가짜 커넥터와 `test/oauth/fakes.ts` 를 함께 갱신.

### D10. modern 세대 다운스트림 (설계 D17)

`@modelcontextprotocol/sdk` 가 2026-07-28 을 지원하는 버전이 나오면: `downstream/server.ts` 의 400 거절을 걷어내고 modern 요청을 SDK 서버 전송으로 처리, `subscriptions/listen` 팬아웃, `ttlMs`·`cacheScope`·`resultType` 부여. 그 전까지는 손대지 않는다.

---

## 3. 우선순위 C — Phase 2 (설계 19.3)

1. **stdio 서버 (C1, 보류).** 구현 전에 아래 제안을 확정하고, Docker 데몬이 있는 호스트에서 검증한다.
   - **실행기.** Docker. 실행기별 이미지: `npx` → `node:22-bookworm-slim`, `uvx` → `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`, `docker` → 사용자가 적은 이미지 (사용자의 docker 플래그는 버리고 `-e KEY`만 인정). 이미지는 설정으로 바꿀 수 있게 한다.
   - **2단계.** 설치 단계는 네트워크를 켜고 서버별 named volume(`omnicode-mcp-<id>`, uid 65534 소유)에 패키지를 받는다 (`npm install --prefix /work <pkg>`, `uv tool install`). 실행 단계는 `--network none`(기본), `--read-only`, `--tmpfs /tmp`, 볼륨 읽기 전용, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--user 65534:65534`, `--pids-limit 128`, `--memory 512m`, `--cpus 1`. npx·uvx 는 시작할 때 레지스트리에 접속하므로 이 분리가 없으면 "기본 네트워크 차단"을 지킬 수 없다.
   - **네트워크 정책.** 서버별 `none`(기본) 또는 `egress`(브리지, 화면 경고 + 재인증으로만 켬). 도메인 허용 목록은 이그레스 프록시(Smokescreen)가 필요해 이후로 미룬다.
   - **비밀값.** `stdio_env` 시크릿 값을 `docker run -e KEY`로 넘기고 값은 docker CLI 프로세스 환경에만 둔다 (명령줄·로그에 남기지 않는다).
   - **수명.** 서버당 컨테이너 하나 (HTTP 와 같이 모든 다운스트림이 공유, 11.2). 비정상 종료는 백오프로 재시작, stderr 는 마스킹해 journald 로, 끄기·삭제 시 kill.
   - **커넥터.** SDK `StdioClientTransport` 로 `docker run -i …` 를 띄워 `LegacyConnector` 에 전송 종류 `stdio` 를 추가한다.
   - **화면·API.** 15장 7번 경고 화면(명령 전체, 위험 패턴 강조), `requireRecentAuth`, JSON 붙여넣기의 stdio 항목을 이 경로로 연결 (`services/servers.ts` 의 `pickJsonEntry` 가 지금은 `unsupported_transport` 를 던진다).
   - **검증.** docker 인자 생성은 순수 함수로 단위 테스트, e2e 는 `npx -y @modelcontextprotocol/server-everything` 류 서버로 도구 호출, 홈·IMDS·네트워크 차단 확인 (`curl` 이 실패해야 한다).
2. ~~**JSON 붙여넣기**~~ **완료 (원격 항목)**: `CreateServerBody.source = 'json'` 처리 (`packages/hub/src/services/servers.ts` 는 지금 `validation_error` 를 던진다). `McpServersJsonSchema` 로 파싱, http 항목은 URL 추가로, stdio 항목은 경고 화면(15장 7번) 뒤 1번으로.
3. ~~**`resources/subscribe` 전달**~~ **완료**: 다운스트림 `-32601` 을 걷어내고 업스트림 구독을 팬아웃.
4. **프리셋 기여 가이드 운영**: `presets/README.md` 를 공개하고 첫 외부 PR 리뷰.

## 4. 우선순위 D — Phase 3

레지스트리 검색(`/api/mcp/registry/search` 는 501), 실행 단위 주입(12.8), elicitation 을 OmniCode 화면으로 받기(11.4), tasks 확장, 통합 엔드포인트 재검토(미결 1).

---

## 5. 작업 보고 형식

작업을 끝내면 다음을 남긴다.

1. 설계문서의 해당 절·19.1·19.2.1·변경 이력 갱신.
2. 커밋 메시지에 설계 장 번호와 바뀐 동작.
3. `npx tsc -b && npx vitest run` 결과(파일·테스트 수)와 새로 추가한 테스트 이름.
4. 설계와 달라진 결정은 20장 결정 기록에 `D19` 부터 추가.
