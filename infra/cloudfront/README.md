# CloudFront 설정 — 캐시와 전달 규칙

OmniCode는 **엣지에서 인증하지 않는다** (설계 0002 1·7장). 로그인 벽은 API 프로세스가 세션 쿠키를
직접 검증하는 것이다. CloudFront는 TLS 종료와 캐시만 맡는다. 예전 안처럼 로그인 검사 함수
(CloudFront Function / Lambda@Edge)를 붙였다면 떼어 낸다 — 붙어 있으면 `/login`, `/setup`,
`/api/auth/*`, `/oauth/callback`까지 막혀 로그인 자체가 불가능해진다.

CloudFront에서 지켜야 할 것은 세 가지다.

1. `/api/*`와 `/oauth/callback`은 **캐시하지 않고**, 쿠키·쿼리 문자열·`Origin`·`Sec-Fetch-Site`·`User-Agent`를
   그대로 오리진에 넘긴다. 세션 쿠키와 요청 위조 방어(0002 7장)가 이 값들에 기대고 있다.
2. `/.well-known/omnicode/client.json`(CIMD)은 오리진 헤더대로 최대 1시간 캐시한다.
3. 배포의 도메인이 `OMNICODE_PUBLIC_URL`의 호스트와 **정확히 같아야** 한다. 패스키는 이 호스트 이름(RP ID)에
   묶인다. 도메인을 바꾸면 기존 패스키로는 로그인할 수 없고 `auth reset`(0002 5.5)이 필요하다.

| 경로 | 캐시 정책 | 오리진 요청 정책 | 메서드 | 이유 |
|---|---|---|---|---|
| `/api/*` | `CachingDisabled` | `AllViewerExceptHostHeader` | 전부 | 세션 쿠키·Origin 검사·JSON 본문 |
| `/oauth/callback` | `CachingDisabled` | `AllViewerExceptHostHeader` | GET, HEAD | `code`·`state`·`iss`를 그대로 전달 (0001 10.3) |
| `/.well-known/omnicode/client.json` | 사용자 정의 1시간 | 없음 | GET, HEAD | 인가 서버가 가져가는 CIMD 문서 (비밀값 없음) |
| 기본 (`*`) | `UseOriginCacheControlHeaders` | 없음 | GET, HEAD | 화면 HTML·JS·CSS. 오리진이 `max-age=0`으로 보내므로 HTML은 매번 확인된다 |

사용한 관리형 정책 ID:

- `CachingDisabled` 캐시 정책: `4135ea2d-6df8-44a3-9df3-4b5a84be39ad`
- `UseOriginCacheControlHeaders` 캐시 정책: `83da9c7e-98b4-4e11-a168-04f0df8e2c65`
- `AllViewerExceptHostHeader` 오리진 요청 정책: `b689b0a8-53d0-40ab-baf2-68738e2966ac` (쿼리 문자열·헤더·쿠키 전부 전달)

## 동작(behavior) 예시

`aws cloudfront get-distribution-config`로 받은 `DistributionConfig.CacheBehaviors`에 아래 세 항목을
넣는다 (`TargetOriginId`는 OmniCode API 오리진의 ID로 바꾼다). 기본 동작(`DefaultCacheBehavior`)은
위 표의 `*` 행대로 둔다.

```json
{
  "CacheBehaviors": {
    "Quantity": 3,
    "Items": [
      {
        "PathPattern": "/api/*",
        "TargetOriginId": "omnicode-api",
        "ViewerProtocolPolicy": "https-only",
        "AllowedMethods": {
          "Quantity": 7,
          "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
        },
        "Compress": true,
        "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
        "FunctionAssociations": { "Quantity": 0 },
        "LambdaFunctionAssociations": { "Quantity": 0 },
        "SmoothStreaming": false,
        "FieldLevelEncryptionId": ""
      },
      {
        "PathPattern": "/oauth/callback",
        "TargetOriginId": "omnicode-api",
        "ViewerProtocolPolicy": "https-only",
        "AllowedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"], "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] } },
        "Compress": false,
        "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
        "FunctionAssociations": { "Quantity": 0 },
        "LambdaFunctionAssociations": { "Quantity": 0 },
        "SmoothStreaming": false,
        "FieldLevelEncryptionId": ""
      },
      {
        "PathPattern": "/.well-known/omnicode/client.json",
        "TargetOriginId": "omnicode-api",
        "ViewerProtocolPolicy": "https-only",
        "AllowedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"], "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] } },
        "Compress": true,
        "CachePolicyId": "<omnicode-cimd-1h 정책 ID>",
        "FunctionAssociations": { "Quantity": 0 },
        "LambdaFunctionAssociations": { "Quantity": 0 },
        "SmoothStreaming": false,
        "FieldLevelEncryptionId": ""
      }
    ]
  }
}
```

`client.json`용 캐시 정책 (오리진의 `max-age`를 따르되 최대 1시간, 쿼리·쿠키·헤더는 캐시 키에서 제외):

```sh
aws cloudfront create-cache-policy --cache-policy-config '{
  "Name": "omnicode-cimd-1h",
  "Comment": "OmniCode CIMD document: honor origin Cache-Control up to 1h",
  "MinTTL": 0, "DefaultTTL": 3600, "MaxTTL": 3600,
  "ParametersInCacheKeyAndForwardedToOrigin": {
    "EnableAcceptEncodingGzip": true, "EnableAcceptEncodingBrotli": true,
    "HeadersConfig": { "HeaderBehavior": "none" },
    "CookiesConfig": { "CookieBehavior": "none" },
    "QueryStringsConfig": { "QueryStringBehavior": "none" }
  }
}'
```

## 남용 방어 (선택)

API는 공개 인증 엔드포인트에 프로세스 단위 속도 제한을 둔다 (0002 7장). 더 막고 싶으면 배포에 AWS WAF를
붙이고 `/api/auth/` 접두사에 IP 기준 속도 제한 규칙(예: 5분에 100회)을 둔다. 엣지에서 인증을 흉내 내는
규칙은 두지 않는다.

## 세션 쿠키와 `SameSite` (0001 16.3, 0002 6장)

세션 쿠키는 `__Host-omnicode_session`, `Secure`, `HttpOnly`, **`SameSite=Lax`** 다. `Strict`는 쓰지 않는다.
인가 서버에서 `/oauth/callback`으로 돌아오는 리다이렉트는 **교차 사이트 최상위 이동**이라 `Strict`
쿠키는 실리지 않기 때문이다. 콜백 자체는 쿠키에 의존하지 않지만(서버 측 `state`), 완료 페이지가
로그인 쿠키를 보고 서버 상세로 리다이렉트하는 동작이 `Strict`에서는 깨진다. iOS 홈 화면 앱(PWA)은
Safari와 쿠키 저장소가 분리될 수 있으므로, 쿠키가 없을 때 "OmniCode로 돌아가세요"를 보여주는
경로도 P8에서 함께 확인한다.

## 확인 (P8)

```sh
# 1. CIMD: 로그인 없이 200, JSON, 캐시 헤더
curl -sSI https://<내 도메인>/.well-known/omnicode/client.json | grep -i -E '^(HTTP|content-type|cache-control|x-cache)'

# 2. 콜백: 오리진까지 도달하고 쿼리가 보존된다 (state가 없으므로 400 oauth_state_invalid가 정상)
curl -sS 'https://<내 도메인>/oauth/callback?state=probe&code=probe' -o /dev/null -w '%{http_code}\n'

# 3. 데이터 API는 세션 없이 401
curl -sS https://<내 도메인>/api/mcp/servers -o /dev/null -w '%{http_code}\n'

# 4. 인증 상태는 공개, 캐시되지 않는다
curl -sSI https://<내 도메인>/api/auth/status | grep -i -E '^(HTTP|cache-control|x-cache)'

# 5. 교차 출처 상태 변경은 403
curl -sS -X POST -H 'Origin: https://evil.example' https://<내 도메인>/api/auth/logout -o /dev/null -w '%{http_code}\n'
```

2번이 로그인 페이지(302/200 HTML)로 떨어지면 엣지 함수가 콜백을 가로채고 있는 것이다. 3번이 200이면
API 인증이 꺼져 있는 것이다 (`OMNICODE_AUTH_MODE`를 확인). 4번에 `x-cache: Hit`이 보이면 `/api/*` 동작의
캐시 정책이 잘못된 것이다.
