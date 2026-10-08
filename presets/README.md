# 프리셋 — 화면의 "프리셋에서 추가" 목록

`presets/<id>.json` 하나가 업스트림 MCP 서버 하나다. 화면은 이 목록을 보여 주고, 사용자가 고르면 URL
전체와 문서 링크를 **그대로 보여 준 뒤** 서버를 추가한다 (설계 9.1, 16.7). 프리셋은 힌트일 뿐이다.
실제 전송 방식·인증 방식은 Hub 가 탐지한 결과를 따르고, 추가된 서버 상세에는 "프리셋 `<id>`에서
추가됨"이 남는다.

프리셋은 오픈소스 기여 지점이자 **공급망 표면**이다 (7.1). 그래서 아래 규칙이 있다.

## 파일 형식

`schema.json` (JSON Schema 2020-12) 이 정의한다. `packages/shared/src/schemas.ts` 의 `PresetSchema` 와 같다.

```json
{
  "id": "fish-audio",
  "displayName": "Fish Audio",
  "description": "음성 생성, 보이스 검색, 음성 인식",
  "transport": "streamable_http",
  "url": "https://api.fish.audio/mcp",
  "auth": { "type": "oauth" },
  "docs": "https://docs.fish.audio/overview/mcp",
  "defaultAgents": ["claude", "codex", "gemini"]
}
```

| 필드 | 필수 | 규칙 |
|---|---|---|
| `id` | O | `[a-z0-9-]{1,40}`, **파일 이름과 같아야 한다** |
| `displayName` | O | 1~80자 |
| `description` | | 400자 이하. 사용자에게 보이는 한 줄 설명 |
| `transport` | O | `streamable_http` 또는 `sse` |
| `url` | O | `https://` 만. 공개 DNS 이름 (IP 리터럴·`localhost`·점 없는 이름 거부) |
| `auth.type` | O | `none` · `header` · `oauth` |
| `auth.headerName` | | `header` 일 때 키를 실을 헤더 이름 (`[A-Za-z0-9-]{1,64}`). 키 값은 사용자가 화면에서 입력한다 |
| `auth.scopes` | | `oauth` 일 때 서버 메타데이터에 scope 가 없으면 요청할 scope 목록 |
| `docs` | | `https://` 문서 링크. `url` 과 같은 호스트 규칙 |
| `defaultAgents` | | `claude` · `codex` · `gemini` 중 중복 없이 최대 3개 |

알 수 없는 필드는 거부된다 (`additionalProperties: false`).

## 기여 절차

1. `presets/<id>.json` 을 추가하거나 고친다. 파일 이름 = `id`.
2. 로컬에서 검증한다: `npm run validate:presets`
3. PR 을 연다. CI 가 같은 검증을 돌린다.
4. **`.github/CODEOWNERS` 에 지정된 리뷰어의 승인 없이는 머지되지 않는다.** 리뷰어는 다음을 확인한다.
   - `url` 과 `docs` 가 그 서비스의 **공식** 엔드포인트·문서인지 (문서 페이지에서 URL 을 직접 확인)
   - 기존 프리셋의 `url` · `auth` 변경은 서버 교체(피싱)와 같은 효과이므로 변경 이유를 PR 본문에서 요구
   - 설명이 사용자를 오도하지 않는지

## CI 가 검증하는 것 (`scripts/validate-presets.mjs`)

- JSON 이 객체이고 `schema.json` 을 만족한다 (타입·enum·패턴·길이·필수 필드·알 수 없는 필드)
- 파일 이름이 `id` 와 같다
- `url` · `docs` 가 `https://` 이고 호스트가 IP 리터럴, `localhost`, 점 없는 이름이 아니며 사용자 정보
  (`https://user:pass@`) 가 없다 (16.2 의 호스트 규칙. 사설 주소 차단은 Hub 가 실행 시점에 다시 한다)
- 비밀값처럼 보이는 키 이름이나 값이 없다 (API 키, 베어러 토큰, `omh_` 토큰, AWS 키, JWT, 개인키 등)

## 하지 말 것

- **비밀값을 넣지 않는다.** API 키·토큰은 사용자가 화면에서 입력하고 Secrets Manager 에만 저장된다.
- 사설 주소, 단축 URL, 리다이렉터, 비공식 미러를 `url` 로 쓰지 않는다. URL 은 사용자에게 그대로 보인다.
- `url` 에 쿼리 문자열로 자격증명이나 사용자 식별자를 넣지 않는다.
- 다른 프리셋을 한 PR 에서 여러 개 바꾸지 않는다. 리뷰 단위를 작게 유지한다.
