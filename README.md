# 오늘 뭐 챙기지?

코디세이 AI 네이티브 M1-2 개인과제

날씨 데이터를 기반으로 외출 준비를 도와주는 AI 비서 웹서비스입니다.

## Firebase 연결 기반 (작업 02)

Python 3.12에서 개발 환경을 준비하고 오프라인 테스트를 실행합니다.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
```

설정은 저장소 루트의 `.env.example`을 `.env`로 복사해 작성하거나, 실행 환경의
환경 변수로 제공합니다. 이미 설정된 환경 변수는 `.env`보다 우선합니다.

- `FIREBASE_PROJECT_ID`: Firebase 콘솔의 **실제 프로젝트 ID**. 표시 이름
  `codyssey-weather-assistant`와 같다고 가정하지 않습니다.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: 서비스 계정 JSON 전체 문자열.
- `FIREBASE_SERVICE_ACCOUNT_PATH`: 서비스 계정 JSON 파일 경로. 상대 경로는
  프로그램 실행 디렉터리를 기준으로 해석하므로 절대 경로를 권장합니다.

인증 방식은 하나를 선택합니다. 두 값이 모두 비어 있지 않으면 **JSON 환경 변수**가
우선하며, 잘못된 JSON이라도 파일 방식으로 자동 전환하지 않고 오류를 반환합니다.
예제 파일에는 인증정보가 없습니다. 이번 작업에서는 키를 발급하거나 입력할 필요가
없습니다. 향후 로컬 키 파일은 Git에서 제외되는 `secrets/`에 보관하고, 임의 이름의
키 파일을 다른 위치에 커밋하지 마세요. `.env`, 키 파일, 가상환경은 커밋 대상이 아닙니다.

향후 FastAPI에서 `backend.firebase.get_firestore_client()`를 호출하면
`(default)` 데이터베이스용 클라이언트를 얻을 수 있습니다. 모듈 import만으로는
환경 설정 읽기, 앱 초기화, 인증 요청, 데이터 조회를 수행하지 않습니다.
첫 호출에서 설정을 검사하고 이름이 지정된 Firebase 앱을 초기화합니다.
프로세스 내 반복·동시 호출은 같은 앱을 재사용하며, 설정 변경 후에는 프로세스를
재시작해야 합니다. 오류는 `FirebaseConfigurationError`로 전달하며 원본 SDK 오류나
인증정보를 출력하지 않습니다. 클라이언트 반환 함수 자체에는 문서 읽기·쓰기 코드가
없습니다. 향후 `data`, `conversations` 컬렉션을 사용할 예정이며 이번에는 생성하지 않습니다.

Firebase Admin SDK는 서비스 계정 IAM 권한으로 동작하므로, 클라이언트용 Firestore
보안 규칙을 권한 제한 수단으로 가정해서는 안 됩니다.

검증 범위:

- 실제 실행: Python 3.12 가상환경에 의존성 설치 및 `unittest` 실행.
- Mock 검증: 인증정보 누락, JSON 형식·구조 오류, JSON/파일 초기화, 우선순위,
  반복·동시 초기화 방지, 클라이언트 반환, import 시 초기화 없음, 오류·로그의 정보 보호.
  테스트의 문자열은 사용할 수 없는 테스트 표식이며 실제 인증키가 아닙니다.
- 미검증: 실제 키 인증, Firebase IAM 권한, 실제 Firestore 연결·조회·쓰기.
  테스트에서는 Firebase 인증 및 클라이언트 생성을 Mock으로 대체합니다.

## 데이터 CRUD 및 통계 API (작업 03)

로컬 실행 명령은 다음과 같습니다. 서버 시작과 `/docs`, `/openapi.json` 접근은
Firebase 인증키 없이 가능합니다. 데이터 API 호출에는 Firebase 설정이 필요하며,
이번 단계의 기능 검증은 실제 연결 대신 Mock Firestore를 사용합니다.

```bash
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

FastAPI는 HTTP 요청을 처리하고 API 문서를 생성합니다. Pydantic은 요청의 날짜·숫자·
문자열 형식을 검사합니다. CRUD는 데이터 추가(Create), 조회(Read), 수정(Update),
삭제(Delete)를 뜻합니다. `backend/main.py`가 앱, `routes.py`가 경로,
`schemas.py`가 입출력 검증, `services.py`가 Firestore 처리와 통계 계산을 담당합니다.

| API | 동작 및 성공 응답 |
| --- | --- |
| `POST /api/data` | 날짜를 문서 ID로 추가, 201 및 저장 데이터 |
| `GET /api/data` | 날짜 오름차순 목록, 200 및 배열 |
| `PUT /api/data/{id}` | 기존 데이터 수정, 200 및 수정 데이터 |
| `DELETE /api/data/{id}` | 기존 데이터 삭제, 200 및 `id`, `deleted: true` |
| `GET /api/data/summary` | 저장된 데이터의 요약, 200 |

요청 본문은 `date`, `value`, `memo` 세 필드입니다. `date`는 유효한 `YYYY-MM-DD`,
`value`는 유한한 JSON 숫자(음수·0 허용, 문자열·불리언·NaN·Infinity 거부),
`memo`는 문자열입니다. 필수 필드 누락과 추가 필드도 거부합니다.
같은 날짜의 POST는 원자적 `create()`로 409를 반환하며 기존 값을 덮어쓰지 않습니다.
PUT의 경로 ID와 본문 날짜가 다르면 422, 없는 문서 수정·삭제는 404입니다.
삭제는 존재 확인과 삭제를 한 Firestore 트랜잭션으로 수행합니다.
잘못된 입력은 422, 설정·Firestore 오류는 내부 상세를 숨긴 503으로 응답합니다.

요약 응답의 `start_date`, `end_date`, `count`, `mean_value`, `max_value`,
`min_value`는 저장된 모든 데이터를 기준으로 계산합니다. 빈 데이터는 `count: 0`,
날짜·통계값은 `null`입니다. `trend`는 마지막 **관측일** 기준 마지막 7일 평균과
직전 7일 평균을 비교합니다. 두 구간의 모든 날짜가 있어야 판단하며, 14일 미만이나
구간 내 날짜 누락 시 `insufficient_data`입니다. 평균 차이가 +0.5°C 이상이면
`rising`, -0.5°C 이하이면 `falling`, 그 사이면 `stable`입니다.
`latest_week_mean`, `previous_week_mean`, `threshold_celsius`도 반환합니다.
판단 불가일 때 두 평균은 `null`입니다. 이 추세는 과거 관측 데이터의 변화이며,
현재 날씨나 미래 예보를 의미하지 않습니다.

`ALLOWED_ORIGINS`에는 쉼표로 구분한 명시적 HTTP(S) origin을 설정합니다.
예: `http://localhost:5173`. 기본값은 빈 목록이며 `*`는 거부합니다.
CORS는 브라우저 접근 정책일 뿐 인증·쓰기 권한 보호 기능이 아닙니다.
현재 인증 없는 CRUD API는 외부에 배포하지 않습니다.
운영 배포 전 인증과 쓰기 권한 보호를 별도로 설계해야 합니다.

Firebase 첫 초기화 시 `FIREBASE_PROJECT_ID`와 서비스 계정 JSON의 `project_id`가
정확히 일치해야 합니다. 불일치 시 인증정보를 출력하지 않고 설정 오류를 반환합니다.
이미 초기화된 앱은 재사용하므로 설정을 변경하면 프로세스를 재시작합니다.

테스트 명령:

```bash
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m tests.run_offline
.venv/bin/python -m pip check
```

Mock 테스트는 CRUD, 중복·없는 문서·입력 검증, 정렬, 통계, 추세의 임계값·날짜 누락,
빈 데이터, 안전한 오류, CORS, Swagger HTML 및 OpenAPI, 프로젝트 ID 일치 검사를
검증합니다. 오프라인 실행기는 import부터 테스트 종료까지 소켓 연결·DNS 요청을
차단합니다. 실제 Firestore의 인증·IAM 권한·트랜잭션·읽기·쓰기는 미검증입니다.
실제 연결 검증 전에는 실제 프로젝트 ID 확인, 안전한 인증정보 제공, 최소 IAM 권한,
테스트 대상 분리와 Spark 무료 사용량 검토가 필요합니다. 이번에는 실제 키 발급,
실제 연결, 365건 업로드, 외부 배포를 수행하지 않습니다.

## Firestore 적재 도구 준비 (작업 04-A)

추가 의존성 없이 기존 가상환경에서 실행합니다. **이번 작업에서는 실제 Firebase에
연결하거나 업로드하지 않았습니다.** 원격 확인·적재 동작은 Mock으로만 검증했습니다.

```bash
# 기본 모드: 로컬 파일 검증과 계획 출력만 수행. 인증정보·네트워크 불필요.
.venv/bin/python scripts/import_temperature.py

# 아래 두 명령은 향후 준비·승인 후에만 실행합니다. 이번에는 실행하지 않습니다.
# 원격 확인: 대상 날짜 문서를 읽기만 하며 쓰기·수정·삭제 없음.
.venv/bin/python scripts/import_temperature.py --check-remote --project-id ACTUAL_PROJECT_ID

# 실제 적재: 프로젝트 ID를 두 번 명시해야 누락 문서 생성 가능.
.venv/bin/python scripts/import_temperature.py --apply --project-id ACTUAL_PROJECT_ID --confirm-project-id ACTUAL_PROJECT_ID
```

`ACTUAL_PROJECT_ID`는 표시 이름이 아닌 실제 프로젝트 ID로 교체해야 합니다.
원격 모드는 `FIREBASE_PROJECT_ID`, 초기화된 Firebase 앱, Firestore 클라이언트의
프로젝트 ID가 명시한 ID와 일치해야 진행합니다. 기존 Firebase 모듈도 서비스 계정의
`project_id` 일치를 검사합니다. 실제 실행 전 안전한 인증정보 제공, 최소 IAM 권한,
`(default)` 데이터베이스 확인, 대상 프로젝트·데이터 검토와 Spark 사용량 확인이
필요합니다. 인증은 기존 JSON 환경 변수 또는 Git에서 제외된 `secrets/`의 로컬 파일
경로를 사용합니다. 실제 키와 `.env`를 저장소에 올리지 마세요.

세 모드 모두 먼저 CSV 전체를 검증합니다. UTF-8, 정확한 `date,value,memo` 컬럼,
365건, 2025-10-01~2026-09-30의 중복·누락 없는 날짜, 유한한 기온, 평균 약 14.24°C,
최소 -9.7°C·최대 33.1°C를 확인합니다. 계산 결과와 원본 SHA-256을 포함한
`validation.json`의 모든 필드가 일치하지 않으면 연결·적재 전에 중단합니다.
입력 CSV·검증 파일·원본은 수정하지 않습니다.

대상은 `data` 컬렉션의 날짜 ID 365개로 고정됩니다. 원격 확인은 대상 문서를 읽고
생성 예정(`pending`), 기존 동일(`existing_identical`), 충돌(`conflicts`),
실패(`failed`) 건수를 출력합니다. 실제 적재도 **모든 대상의 사전 읽기**를 완료한
뒤에만 생성합니다. 기존 충돌이나 읽기 실패가 있으면 생성은 0건입니다.
이 읽기 작업도 Firestore 사용량에 포함되며, 기본 원격 확인/사전 확인은 대상 문서
365개를 조회합니다. 실제 비용·무료 한도는 실행 전에 확인해야 합니다.

동일 여부는 `date`, 숫자 `value`, 문자열 `memo` 전체로 판단합니다. 메모 차이나
예상하지 않은 필드가 있는 문서도 보수적으로 충돌 처리합니다. 같은 데이터는 건너뛰고
다른 데이터는 덮어쓰지 않습니다. 누락 문서만 원자적 `create()`로 생성합니다.
사전 확인 후 다른 작업이 문서를 만들면 `AlreadyExists`를 잡아 재조회하고, 동일하면
건너뛰며 다르면 즉시 중단합니다. 삭제·초기화·자동 적재 기능은 없습니다.

여러 문서의 적재 전체는 하나의 트랜잭션이 아닙니다. 중간 실패 시 이미 성공한 생성은
유지되며 남은 생성은 멈춥니다. 타임아웃은 서버 저장 이후 발생할 수도 있어 `failed`가
반드시 미저장을 뜻하지 않습니다. 결과의 `created`, `existing_identical`, `conflicts`,
`failed`, `pending`과 관련 날짜를 확인하고, 재실행하면 저장 상태를 다시 읽어 동일한
문서를 건너뜁니다. 성공 확인 전 무조건 재시도하거나 기존 문서를 삭제하지 않습니다.
기본 검증 성공·충돌 없는 원격 확인·적재 완료는 종료 코드 0, 검증 오류·충돌·실패는
종료 코드 1입니다. 오류 출력에는 입력 내용·인증정보·SDK 내부 상세를 포함하지 않습니다.

테스트는 기존 명령 `.venv/bin/python -m tests.run_offline`으로 전체 실행합니다.
CSV 검증, 기본 모드의 Firebase 호출 없음, 승인·프로젝트 확인, 읽기 전용 확인,
신규 생성·중복·충돌·동시 생성, 부분 실패 및 저장 후 타임아웃의 재실행 처리를
Mock으로 검증합니다. 실제 인증, Firestore 읽기·쓰기, IAM 권한·사용량은 미검증입니다.

## AI 채팅 및 대화 기록 (작업 05)

앱 실행·테스트 명령은 기존과 같습니다. 공식 `openai` SDK를 추가하며,
모델 클라이언트는 채팅 요청 시에만 생성합니다. 키 없이도 앱 import와 `/docs`,
`/openapi.json` 접근이 가능합니다. 실제 GPT·Firestore 연결은 이번 작업에서 실행하지
않았고, 원격 API 호환성과 실제 응답 품질은 추후 검증 대상입니다.

설정은 서버 환경 변수 또는 Git에서 제외된 `.env`로 제공합니다.
`.env.example`의 `OPENAI_API_KEY`는 빈 값으로 유지하고 실제 키는 커밋하지 마세요.
`OPENAI_BASE_URL` 기본값은 `https://copa.codyssey.kr/v1`, `OPENAI_MODEL` 기본값은
`gpt-5.4-mini`입니다. HTTPS URL만 허용하며 키는 응답·프론트엔드에 전달하지 않습니다.
서버의 기존 Firebase 설정도 필요합니다. 이번에는 실제 키를 입력할 필요가 없습니다.

| API | 요청 및 성공 응답 |
| --- | --- |
| `POST /api/chat` | `question` 필수, `conversation_id` 선택 → 200, `conversation_id`, `response` |
| `POST /api/conversations` | 빈 대화 생성 → 201, `id`, `created_at`, `updated_at`, `message_count` |
| `GET /api/conversations` | 수정일 최신순 목록 → 200, 위 메타데이터 배열 |
| `GET /api/conversations/{id}` | 상세 → 200, `id`, 생성일·수정일, 순서가 보존된 `messages` |
| `DELETE /api/conversations/{id}` | 지정한 대화만 삭제 → 200, `id`, `deleted: true` |

ID는 UUID v4입니다. 존재하지 않는 대화는 404, 잘못된 질문·ID는 422입니다.
모델 실패·빈 답변·키 누락은 안전한 502, 타임아웃은 504, 저장소 오류는 503으로
응답하며 내부 인증정보·SDK 상세를 노출하지 않습니다. 허위 대체 답변을 만들지 않습니다.

채팅은 기존 `DataService.summary()`의 기간, 개수, 평균·최고·최저 일평균기온과
마지막 관측일 기준 추세를 검증·JSON 직렬화해 system 메시지에 포함합니다.
서울 관측지점 108의 **과거 관측치**이며 실시간 자료나 예보가 아님을 명시합니다.
현재 기온·강수량·강수확률을 지어내지 않고, 현재 날씨가 필요하면 한계를 설명하며,
우산·복장 추천도 확인된 정보 범위로 제한하도록 지시합니다. 빈 데이터는 자료 부재를
명시합니다. 사용자 입력과 이전 기록은 user/assistant 역할로만 전달하며 시스템
지침보다 높은 권한으로 취급하지 않습니다. 이 지침의 실제 모델 준수는 미검증입니다.

Firestore `conversations/{UUID}` 한 문서에 UTC 타임스탬프 `created_at`, `updated_at`과
`messages: [{role: "user"|"assistant", content: "..."}]` 배열을 저장합니다.
성공한 질문·답변을 한 쌍으로 저장한 뒤에만 성공 응답을 반환합니다. 신규 채팅의 모델
실패는 빈 대화도 만들지 않습니다. 기존 대화는 트랜잭션에서 최신 기록을 다시 읽고
쌍을 추가하므로 동시 수정 시 이전 기록을 덮어쓰지 않습니다. 모델 호출은 트랜잭션
밖에서 수행해 트랜잭션 재시도로 토큰을 반복 소비하지 않습니다.
동시 질문의 답변은 같은 이전 맥락을 참고할 수 있으며 저장 순서는 커밋 순서입니다.
모델 생성과 Firestore 저장은 하나의 트랜잭션이 아닙니다. 모델 성공 후 저장 실패도
오류를 반환하며, 저장 후 타임아웃일 경우 실제 저장 여부는 상세 조회로 확인해야 합니다.
채팅 HTTP 재전송의 중복 방지는 구현하지 않았으므로 오류 후 무조건 재전송하지 마세요.

질문은 공백 제거 후 1~2,000자, 답변은 최대 4,000자입니다. 모델에 전달하는 이전
맥락은 최근 완전한 질문·답변 쌍의 최대 20개 메시지·12,000자로 제한하며,
현재 질문과 system 메시지는 별도로 포함합니다. 요청 타임아웃은 30초,
SDK 자동 재시도는 0회, 출력 제한은 `max_completion_tokens=512`입니다.
한 대화의 저장 한도는 100개 메시지·전체 본문 100,000자입니다. 기존 기록을 임의로
삭제하지 않고 한도 도달 시 409로 새 대화를 안내합니다. 요청 전에는 답변 최대 길이
여유를 확인하며 트랜잭션에서도 저장 한도를 다시 검사합니다.

`.venv/bin/python -m tests.run_offline`으로 전체 회귀 테스트를 실행합니다.
OpenAI SDK와 Firestore는 Mock이며 실제 키·외부 요청·토큰 소비 없이 채팅, 자동 저장,
조회·삭제·정렬, 실패·빈 응답, 프롬프트·맥락 제한, 동시 요청과 트랜잭션 재시도를
검증합니다. 실제 인증·원격 API 호환성·Firestore 트랜잭션·모델 답변 품질·비용은
미검증입니다. 인증 없는 채팅·쓰기 API는 외부에 배포하지 않으며, CORS를 인증이나
대화 소유권 보호로 간주하지 않습니다. 운영 전 인증·대화 접근 권한을 별도 검토해야 합니다.

## 프론트엔드 MVP (작업 06)

`frontend/`는 HTML·CSS·Vanilla JavaScript 정적 화면입니다. 실행에 Node 패키지나
프레임워크 빌드가 필요하지 않습니다. 저장소 루트에서 다음 명령으로 로컬에서만 제공합니다.

```bash
python3 -m http.server 5173 --bind 127.0.0.1 --directory frontend
```

브라우저에서 `http://127.0.0.1:5173`을 엽니다. `file://`로 직접 열지 마세요.
`frontend/config.js`의 공개 `API_BASE_URL`만 FastAPI 서버 주소로 변경합니다.
기본 주소는 `http://127.0.0.1:8000`이며 `/api`를 붙이지 않습니다.
이 설정에는 키나 인증정보를 넣지 않습니다. 브라우저는 기존 FastAPI API 10개만 호출하고
Firebase·Codyssey GPT API를 직접 호출하지 않습니다. `localhost`와 `127.0.0.1`은
서로 다른 origin이므로 실제 접속한 주소와 백엔드 `ALLOWED_ORIGINS`를 일치시켜야 합니다.
예: `ALLOWED_ORIGINS=http://127.0.0.1:5173`. 백엔드 프로세스 재시작 후 적용됩니다.
HTTPS 화면에서는 HTTPS 백엔드 주소를 사용해야 합니다.

채팅, 새 대화·이전 대화 조회·삭제, 날짜순 데이터 CRUD, 서버 요약을 제공합니다.
전송 중에는 중복 전송과 대화 변경을 막고 실패 시 질문을 보존합니다.
삭제에는 확인 창이 있으며 수정 중 날짜는 변경할 수 없습니다.
요청 시간 초과·저장 오류는 저장 여부를 확인한 뒤 수동 재시도하도록 안내합니다.
응답을 자동 재시도하지 않습니다. 오류 응답의 내부 상세는 화면에 표시하지 않습니다.
실시간 날씨는 표시하지 않으며 자료 없음·추세 판단 불가 상태를 구분합니다.
외부 응답은 `textContent`로 표시하고 HTML·Markdown을 실행하지 않습니다.

테스트 준비·실행:

```bash
cd frontend
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

이미 Chromium이 설치되어 있으면 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 환경 변수에 실행
파일 경로를 지정할 수 있습니다. Playwright는 테스트용 의존성이며 화면 실행에는 불필요합니다.
브라우저 테스트는 임시 로컬 정적 서버와 HTTP 응답 Mock만 사용합니다. 외부 요청은 차단하고
테스트 화면에 Mock 표시를 넣습니다. 테스트용 응답은 `frontend/tests/`에만 있으며,
제품 화면에는 Mock 모드가 없습니다. 스크린샷은 Git에서 제외되는 `frontend/test-results/`에
저장됩니다. Chromium PC·모바일 렌더링, 요청 방식, 빈 상태·오류, 키보드 전송, 삭제 확인,
중복 전송 차단과 XSS 방지를 검증합니다. 실제 서비스 연결·응답 품질은 미검증입니다.

이번 작업의 Python 회귀 검증은 실제 데이터 사용 금지에 따라 아래 Mock 테스트 66개를
실행합니다. 실제 CSV를 읽는 적재 테스트 24개는 실행하지 않으며 해당 코드·입력은 그대로입니다.

```bash
.venv/bin/python -m unittest tests.test_firebase tests.test_data_api tests.test_chat_api -q
```

향후 정적 호스팅은 `frontend/`를 대상으로 빌드 없이 구성할 수 있지만 이번에는 Vercel 등
공개 배포를 하지 않습니다. 현재 API에는 공개 사용자 인증·대화 소유권 보호가 없으며,
CORS는 인증 기능이 아닙니다. 실제 키·Firestore 연결·GPT 호출도 이번 검증에 사용하지 않습니다.

### 기온 시계열 그래프 (작업 06-B)

기온 데이터 관리 화면에 **서울 일별 평균기온 변화** SVG 그래프를 추가했습니다.
기존 `GET /api/data` 응답의 날짜·기온만 사용하며 날짜 오름차순으로 표시합니다.
X축은 실제 관측 날짜 간격, Y축은 일평균기온(°C)입니다. 음수·0°C를 지원하며
누락 날짜는 값을 채우거나 선으로 연결하지 않습니다. 추가·수정·삭제 후 기존 목록
새로고침과 함께 갱신됩니다. 숫자 요약·추세 API는 기존 동작을 유지합니다.

외부 CDN·차트 라이브러리는 사용하지 않습니다. 화면 폭에 맞춰 SVG를 다시 그리며
축 글씨는 14px, 모바일은 날짜 눈금 수를 줄입니다. SVG 제목·접근성 설명과 각 점의
날짜·기온 툴팁을 제공하며 상세 값은 기존 데이터 목록에서 확인할 수 있습니다.
빈 자료·API 실패·잘못된 날짜/기온·중복 날짜는 안전한 안내로 표시합니다.
과거 관측 자료이며 실시간 기온이나 미래 예보가 아닙니다.

기존 `npm test`, `npm run test:browser`에 그래프 검증을 포함했습니다.
Mock으로 정렬·누락 구간·음수·0°C·400건·단일 관측·빈 상태·오류·CRUD 갱신·XSS와
Chromium 모바일/PC 렌더링을 검증합니다. Python 전체 회귀는
`.venv/bin/python -m tests.run_offline`으로 실행했으며 로컬 CSV 검증을 포함합니다.
실제 Firestore·GPT 요청이나 외부 배포는 수행하지 않았습니다.
