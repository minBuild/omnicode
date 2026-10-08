# OmniCode

각자 자기 AWS 계정(CloudFront + EC2 + Secrets Manager)에 설치해서 쓰는 개인 에이전트 작업 환경.
EC2에서 공식 CLI(Claude Code, Codex CLI, Gemini CLI)를 실행하고, 폰이나 PC 브라우저에서 작업을 이어간다.

이 저장소의 첫 기능은 **화면에서 MCP 서버를 추가·관리하기**다. 설계는 [`docs/design/0001-mcp-management.md`](docs/design/0001-mcp-management.md)에 있고, 코드는 그 설계의 장 번호를 주석으로 가리킨다. 남은 작업은 [`docs/handoff/0001-mcp-remaining-work.md`](docs/handoff/0001-mcp-remaining-work.md)에 우선순위와 완료 조건과 함께 정리돼 있다.

## 구조

```
packages/
  shared/   공용 타입·zod 스키마·오류 코드·해시·마스킹        (@omnicode/shared)
  hub/      MCP Hub: 업스트림 커넥터, OAuth, 레지스트리(SQLite), 에이전트용 로컬 MCP 서버 (@omnicode/hub)
  agentd/   omniagent 사용자로 도는 데몬: CLI 설정 파일·토큰 파일 편집   (@omnicode/agentd)
  api/      Fastify API (/api/mcp/*, /oauth/callback, CIMD 문서), 서버 진입점 (@omnicode/api)
  web/      Vite + React 모바일 우선 화면                       (@omnicode/web)
  tools/    omnicode-hub-headers (Claude Code headersHelper)
presets/    기여 가능한 MCP 서버 프리셋 (schema.json 으로 검증)
infra/      systemd 유닛, iptables 가드, 백업 스크립트, 설치 스크립트 조각, IAM 정책, CloudFront 메모
docs/       설계문서
```

핵심 구조 (설계 1장):

- **Hub** 가 업스트림 MCP 서버에 연결하는 유일한 클라이언트다. OAuth 로그인·API 키 주입을 한곳에서 처리하고, 각 CLI 에는 `http://127.0.0.1:7410/mcp/<id>` 로컬 주소만 등록한다.
- **에이전트는 신뢰하지 않는다.** Hub·API 는 `omnicode` 사용자, 에이전트는 `omniagent` 사용자로 분리하고 에이전트의 IMDS 접근을 막는다. 업스트림 자격증명은 에이전트가 실행하는 코드로 읽을 수 없다.
- **에이전트별 토큰** 으로 호출자를 식별해 바인딩을 강제하고 감사 로그를 남긴다.

## 개발

요구 사항: Node.js 22.13 이상 (`node:sqlite` 내장), npm.

```bash
npm install
npx tsc -b                 # 전체 타입 검사·빌드
npx vitest run             # 전체 테스트 (hub·agentd·api·shared·web)
npm run build --workspace @omnicode/web
npm run validate:presets
```

로컬에서 서버 띄우기 (AWS 없이, 메모리 시크릿 + 개발용 인증):

```bash
export OMNICODE_SECRETS_BACKEND=memory
export OMNICODE_DATA_DIR=/tmp/omnicode-dev
export OMNICODE_AGENTD_SOCKET=/tmp/omnicode-agentd.sock
export OMNICODE_DEV_TOKEN=dev-token-change-me-please
export OMNICODE_MCP_ALLOW_HTTP_LOOPBACK=1
node packages/agentd/dist/main.js &          # HOME 의 CLI 설정을 편집한다 — 개발용 HOME 을 따로 두는 것을 권장
node packages/api/dist/main.js               # API :8080, Hub 127.0.0.1:7410
```

화면은 `http://127.0.0.1:8080/mcp`. 개발 모드에서는 로그인 화면에 `OMNICODE_DEV_TOKEN` 값을 넣으면 된다 (API는 `Authorization: Bearer <토큰>`도 받는다).

운영과 같은 패스키 로그인(설계 [0002](docs/design/0002-auth.md))을 로컬에서 쓰려면 `OMNICODE_DEV_TOKEN` 대신 아래처럼 띄운다. 패스키는 보안 컨텍스트가 필요하므로 `localhost`로 접속한다.

```bash
export OMNICODE_AUTH_MODE=session
export OMNICODE_PUBLIC_URL=http://localhost:8080
node packages/api/dist/main.js
cat /tmp/omnicode-dev/setup-token             # 첫 패스키 등록용 1회 토큰 → http://localhost:8080/setup
```

화면만 고칠 때는 `npm run dev --workspace @omnicode/web`(Vite, `/api`·`/oauth`를 :8080으로 프록시)를 쓰거나, API에 `OMNICODE_WEB_LIVE=1`을 주면 웹을 다시 빌드해도 재시작이 필요 없다. 환경변수 전체 목록은 [`.env.example`](.env.example).

## 테스트

| 패키지 | 내용 |
|---|---|
| `packages/shared/test` | JCS 해시, 마스킹, 스키마 |
| `packages/hub/test/net` | SSRF 말뭉치, DNS 고정, 리다이렉트 |
| `packages/hub/test/registry` | 마이그레이션, 상태 전이표 전수, 승인 해시 |
| `packages/hub/test/upstream` | legacy·modern 가짜 업스트림에 대한 세대 감지, 타임아웃, MRTR 정책 |
| `packages/hub/test/oauth` | 가짜 인가 서버: CIMD/DCR/사전등록, iss, refresh 단일 비행 |
| `packages/hub/test/downstream` | SDK 클라이언트가 에이전트 역할로 접속: 토큰, 정책, progress, 알림 |
| `packages/hub/test/hub.integration.test.ts` | 추가 → 승인 → 동기화 → 호출 → 감사 → 삭제 전체 흐름 |
| `packages/agentd/test` | CLI 설정 파일 편집(바이트 보존), 소켓 프로토콜 |
| `packages/api/test` | 라우트, 오류 매핑, 보안 헤더, 콜백 페이지, 패스키 로그인·재인증 (소프트웨어 인증기로 실제 WebAuthn 검증) |
| `packages/web/test` | API 클라이언트·가로채기·순수 함수 (node), 화면 상호작용 (`dom/*.test.tsx`, jsdom) |

## 배포

`infra/install/mcp-feature.sh` 가 사용자·디렉터리·systemd·iptables·IMDSv2 설정을 담당한다 (설계 17.6). 소스 빌드와 서비스 재시작은 `infra/bin/omnicode-deploy` 가 한다 (`npm ci` → `npm run build` → 웹 빌드 → `systemctl restart`). 에이전트 토큰은 `omnicode.service` 가 첫 기동 때 자동으로 만들어 agentd 를 통해 `/home/omniagent/.omnicode/tokens/` 에 쓴다. CloudFront 공개 경로 두 개(`/.well-known/omnicode/client.json`, `/oauth/callback`)는 [`infra/cloudfront/README.md`](infra/cloudfront/README.md) 참고. 아직 Phase 0 검증 목록(설계 19.1)의 실제 CLI·EC2 항목은 수행 전이다.
