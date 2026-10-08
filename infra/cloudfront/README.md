# CloudFront 설정 조각 — 로그인 벽의 공개 경로 2개

OmniCode 화면은 CloudFront 뒤에서 로그인 없이는 열리지 않는다 (설계 16.1). 이 기능은 그 벽에
**정확히 두 개의 예외 경로**를 요구한다 (설계 8.3, 10.3, 17.6-7, 확인 항목 P8). 다른 경로는 추가하지
않는다.

| 경로 | 캐시 | 쿼리 문자열 | 메서드 | 이유 |
|---|---|---|---|---|
| `/.well-known/omnicode/client.json` | **1시간** (오리진이 `Cache-Control: public, max-age=3600`을 보낸다) | 전달하지 않음 | GET, HEAD | CIMD(client ID metadata document). 인가 서버가 `client_id` URL을 직접 가져온다. 비밀값 없음 |
| `/oauth/callback` | **없음** | **전부 그대로 오리진에 전달** (`code`, `state`, `iss`, `error`, `error_description`) | GET, HEAD | 인가 서버가 사용자를 돌려보내는 곳. API가 서버 측 1회용 `state`로 검증하므로 로그인 쿠키가 필요 없다 (D10) |

두 경로 모두 **로그인 검사 함수(CloudFront Function / Lambda@Edge)가 붙어 있으면 안 된다.**
로그인 함수가 기본 동작(`*`)에만 붙어 있으면 아래처럼 별도 동작(behavior)을 추가하는 것으로
충분하다. 함수가 모든 동작에 붙는 구조라면, 함수 안에 이 두 경로의 허용 목록을 두어야 한다.

## 동작(behavior) 예시

`aws cloudfront get-distribution-config`로 받은 `DistributionConfig.CacheBehaviors`에 아래 두 항목을
추가한다 (`TargetOriginId`는 OmniCode API 오리진의 ID로 바꾼다). 사용한 관리형 정책 ID:

- `CachingDisabled` 캐시 정책: `4135ea2d-6df8-44a3-9df3-4b5a84be39ad`
- `AllViewerExceptHostHeader` 오리진 요청 정책: `b689b0a8-53d0-40ab-baf2-68738e2966ac` (쿼리 문자열·헤더·쿠키 전부 전달)
- `client.json`용 캐시 정책은 아래 명령으로 만든 사용자 정의 정책의 ID를 넣는다.

```json
{
  "CacheBehaviors": {
    "Quantity": 2,
    "Items": [
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

## 세션 쿠키와 `SameSite` (설계 16.3)

세션 쿠키는 `__Host-` 접두사, `Secure`, `HttpOnly`, **`SameSite=Lax`** 로 둔다. `Strict`는 쓰지 않는다.
인가 서버에서 `/oauth/callback`으로 돌아오는 리다이렉트는 **교차 사이트 최상위 이동**이라 `Strict`
쿠키는 실리지 않기 때문이다. 콜백 자체는 쿠키에 의존하지 않지만(서버 측 `state`), 완료 페이지가
로그인 쿠키를 보고 서버 상세로 리다이렉트하는 동작이 `Strict`에서는 깨진다. iOS 홈 화면 앱(PWA)은
Safari와 쿠키 저장소가 분리될 수 있으므로, 쿠키가 없을 때 "OmniCode로 돌아가세요"를 보여주는
경로도 P8에서 함께 확인한다.

## 확인 (P8)

```sh
# 1. CIMD: 로그인 없이 200, JSON, 캐시 헤더
curl -sSI https://<내 도메인>/.well-known/omnicode/client.json | grep -i -E '^(HTTP|content-type|cache-control|x-cache)'

# 2. 콜백: 로그인 없이 오리진까지 도달하고 쿼리가 보존된다 (state가 없으므로 400 oauth_state_invalid가 정상)
curl -sS 'https://<내 도메인>/oauth/callback?state=probe&code=probe' -o /dev/null -w '%{http_code}\n'

# 3. 다른 경로는 여전히 로그인 벽에 막힌다
curl -sS https://<내 도메인>/api/mcp/servers -o /dev/null -w '%{http_code}\n'
```

2번이 로그인 페이지(302/200 HTML)로 떨어지면 로그인 함수가 콜백을 가로채고 있는 것이다. 3번이 200이면
공개 범위가 너무 넓다.
