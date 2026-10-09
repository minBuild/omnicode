# infra/local — 내 배포의 실제 설정 (커밋되지 않음)

이 폴더의 파일은 `.gitignore`가 막는다. 이 README만 저장소에 있다.
실제 도메인, 버킷 이름, 계정 ID, 키처럼 공개하면 안 되는 값은 여기에만 둔다.

| 파일 (예) | 만드는 법 | 쓰는 곳 |
|---|---|---|
| `omnicode.env` | 저장소 루트의 `.env.example`을 복사해 값을 채운다 | EC2의 `/etc/omnicode/omnicode.env`로 복사 (`root:omnicode` 0640) |
| `iam-policy.json` | `infra/aws/iam-policy.json`의 `__OMNICODE_BACKUP_BUCKET__`을 실제 버킷으로 바꾼다 | `aws iam put-role-policy --policy-document file://infra/local/iam-policy.json` |
| `cloudfront-distribution.json` | `aws cloudfront get-distribution-config --id <ID> > infra/local/cloudfront-distribution.json` 후 `infra/cloudfront/README.md`대로 동작을 고친다 | `aws cloudfront update-distribution --if-match <ETag> --distribution-config file://…` |
| `*.pem` | EC2 키 페어 | `ssh -i infra/local/<키>.pem` |
| `notes.md` | 인스턴스 ID, 공개 URL, 리전 같은 메모 | 본인용 |

## 로컬에서 실제 설정으로 시험하기

`.env.example` 형식은 셸에서 그대로 읽을 수 있다 (변수 확장이 없는 `KEY=value`).

```bash
set -a; . infra/local/omnicode.env; set +a
export OMNICODE_SECRETS_BACKEND=file OMNICODE_DATA_DIR=/tmp/omnicode-local   # AWS 없이 시험할 때
npm run build && node packages/api/dist/main.js
```

Secrets Manager까지 실제로 쓰려면 `OMNICODE_SECRETS_BACKEND=aws`로 두고 `AWS_PROFILE`이나 `AWS_REGION`을 지정한다. 이 경우 로컬 자격증명으로 `omnicode/*` 시크릿이 만들어진다.

## 커밋 전에 확인

```bash
git status --ignored infra/local     # 여기 파일이 "Ignored"로 보여야 한다
git check-ignore -v infra/local/omnicode.env
```
