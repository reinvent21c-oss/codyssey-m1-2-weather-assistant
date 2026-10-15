# 오늘 뭐 챙기지?

코디세이 AI 네이티브 M1-2 개인과제

날씨 데이터를 기반으로 외출 준비를 도와주는 AI 비서 웹서비스입니다.

현재 `/api`는 평가용 `X-Evaluation-Code` 헤더가 필요합니다. 실제 코드는 저장소에
없으며, 현재 권한·제한은 아래 **작업 08-C2** 절이 이전 작업 07의 단일 코드 정책을 대체합니다.

## 평가용 최소 보안 (작업 08-C2)

실제 날씨 API는 아직 없습니다. 과거 365건의 관측 자료는 현재 날씨나 미래 예보의
대체재가 아닙니다. 이번 변경은 평가용 원본 보호와 GPT 호출량 제한만 다룹니다.

사용자가 서버의 비공개 환경 설정에 `EVALUATION_ACCESS_CODE`와 **다른**
`ADMIN_ACCESS_CODE`를 직접 입력합니다. 코드 생성·입력·공유는 자동 수행하지 않습니다.
둘 다 충분히 긴 서로 다른 값을 사용하고 앞뒤 공백을 피하세요. 실제 값을 JS·Git·로그에
넣지 마세요. 환경변수 변경 후 서버를 재시작해야 합니다.
평가자 코드가 비어 있으면 모든 업무 API를 401로 차단합니다. 관리자 코드가 없거나
공백이거나 평가자 코드와 동일하면 관리자 권한을 부여하지 않습니다. 같은 코드는
평가자 권한으로만 동작합니다. 관리자 전용 기능 요청은 평가자에게 403을 반환합니다.

| 기능 | 평가자 코드 | 관리자 코드 |
| --- | --- | --- |
| GET /api/access | authenticated + role=evaluator | authenticated + role=admin |
| GET /api/data, /api/data/summary | 허용 | 허용 |
| POST/PUT/DELETE /api/data | 403 | 기존 CRUD 유지 |
| POST /api/chat (conversation_id 없음) | 새 질문·답변 저장 | 허용 |
| POST /api/chat (기존 conversation_id) | 403, UUID를 알아도 차단 | 대화 이어가기 |
| /api/conversations 생성·목록·상세·삭제 | 403 | 기존 기능 유지 |

같은 접근 화면에 관리자 코드를 입력하면 관리자 모드가 됩니다. 관리자는 기온 자료
화면의 추가/수정/삭제, 대화 목록/조회/삭제와 이어가기를 사용해 과제 CRUD를 시연할 수
있습니다. 원본 365건을 대상으로 파괴적인 시연을 하지 말고, 별도 승인한 테스트 데이터나
평가 프로젝트 사본을 사용하세요. UI를 숨기는 것과 별개로 서버가 권한을 검사합니다.

평가자 UI는 대화 기록·새 대화·수정·삭제 메뉴를 숨기며 자료 조회·그래프는 유지합니다.
질문은 매번 독립된 새 대화로 저장하고 화면에는 마지막 질문·답변만 보여줍니다.
평가자의 질문·답변은 Firestore에 저장되어 관리자에게 보일 수 있으므로 **개인정보를
입력하지 마세요**. 개인별 계정·소유권 시스템은 없으며 관리자 코드를 공유하면 모든
대화에 접근할 수 있습니다. 403/429는 자동 재시도하지 않습니다.

### GPT 시간창 제한과 운영 제약

기본값은 **전체 5회/600초(10분)** 입니다. 관리자를 포함해 하나의 앱 프로세스 안에서
모든 코드가 같은 한도를 공유합니다. 짧은 평가 시연을 허용하면서 반복 호출을 낮추기
위해 보수적으로 선택했습니다. 서버의 `GPT_RATE_LIMIT_REQUESTS`와
`GPT_RATE_LIMIT_WINDOW_SECONDS`를 양의 정수로 설정해 변경할 수 있습니다.
빈 값은 기본값을 사용하고 0·음수·숫자가 아닌 값은 앱 시작을 실패시킵니다.

락과 단조 시계 기반 rolling window로 요청을 원자적으로 예약합니다. 초과 시 429와
Retry-After(초)를 반환합니다. 인증/권한/입력/기존 대화 용량/통계 조회를 통과한 뒤,
모델 호출 직전에 카운트합니다. 모델 오류·시간초과·응답 검증 실패·후속 저장 실패도
예약을 돌려주지 않습니다. 실패한 요청을 반복해 제한을 우회할 수 없도록 하기 위함입니다.
통계는 제한 확인 전 읽으므로 429 요청도 Firestore 읽기를 발생시킬 수 있습니다.

메모리 한도는 **과금 하드 캡이 아닙니다**. 재시작/재배포 시 초기화되고 복수 앱·worker·
인스턴스마다 따로 적용됩니다. 평가 배포는 단일 worker/인스턴스를 전제로 합니다.
기존 실행 명령 `python -m backend.run`은 단일 worker입니다. Copa 또는 개인 API 제공자
측 크레딧/쿼터 제한을 별도로 설정하고 사용량을 확인하세요. 시간초과 후에도 서버/제공자
처리가 계속되어 비용이나 저장이 발생할 수 있으므로 무작정 재전송하지 마세요.
일반 공개 서비스용 인증·분산 제한·감사 체계는 후속 범위입니다.

### 안전한 회귀 검증

Python은 일반 unittest를 기준으로 실행합니다. 비밀 설정 파일을 로드하지 않도록
dotenv 로더를 먼저 Mock한 아래 명령은 실제 키 없이 전체 Mock 회귀를 실행합니다.

```powershell
.\.venv\Scripts\python.exe -c "import unittest; from unittest.mock import patch; guard=patch('dotenv.load_dotenv'); guard.start(); suite=unittest.defaultTestLoader.discover('tests'); result=unittest.TextTestRunner(verbosity=1).run(suite); guard.stop(); raise SystemExit(not result.wasSuccessful())"
```

`frontend/`에서 `npm.cmd test`와 `npm.cmd run test:browser`를 실행합니다. 브라우저
테스트는 localhost 정적 서버와 요청 Mock만 사용하며 외부 API 요청은 차단합니다.
설치가 필요하면 잠금 파일 기준 `npm.cmd ci`와 Playwright Chromium 준비가 필요합니다.
실제 DB/GPT 호출·배포는 이 테스트에 포함되지 않으며 별도 승인 대상입니다.

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

## 평가용 접근 보호 및 배포 준비 (작업 07)

백엔드의 `EVALUATION_ACCESS_CODE`를 사용자가 나중에 직접 안전하게 설정합니다.
`.env.example`은 빈 값이며 실제 값을 코드·문서·config.js에 넣지 않습니다.
앞뒤 공백 없는 충분히 긴 ASCII 값을 사용하고 필요한 평가 참여자에게만 별도로 전달하세요.
환경 변수 또는 Git에서 제외되는 로컬 `.env`로 설정한 뒤 서버를 시작합니다.
서버 설정이 없거나 요청 헤더가 없거나 틀리면 동일한 401로 거부합니다.
문자열은 `hmac.compare_digest`로 비교하며 응답·애플리케이션 로그에 코드를 출력하지 않습니다.
리버스 프록시나 별도 모니터링에도 인증 헤더를 기록하지 않도록 설정해야 합니다.

기존 API 10개 모두 GET/POST/PUT/DELETE에 같은 검증을 적용합니다.
추가한 `GET /api/access`는 같은 검증 후 `{"authenticated": true}`만 반환하며
Firestore·GPT를 호출하지 않습니다. `/docs`, `/openapi.json`은 공개 열람 가능하고,
Swagger의 **Authorize → EvaluationCode**에 코드를 입력해야 API를 실행할 수 있습니다.
CORS는 기존 명시적 origin 목록을 유지하며 `X-Evaluation-Code` 헤더와 정상 preflight를
허용합니다. CORS는 인증이 아닙니다.

프론트엔드는 시작 시 password 입력 화면을 보여주고 `/api/access`로 확인합니다.
성공한 뒤에만 기존 화면을 열며 모든 API 요청에 헤더를 보냅니다.
코드는 JavaScript 메모리에만 유지하고 제출 즉시 입력란을 비웁니다.
URL·HTML·쿠키·localStorage·sessionStorage에는 저장하지 않습니다.
새로고침 또는 **접근 코드 다시 입력**을 누르면 다시 입력해야 합니다.
코드 확인 실패나 서버 초기 구동 지연은 안전한 안내만 표시하고 자동 재시도하지 않습니다.
헤더가 다른 서버로 전달되지 않도록 API 리다이렉트도 거부합니다.

### 로컬 실행

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
# .env 또는 서버 환경 변수에 사용자가 EVALUATION_ACCESS_CODE를 먼저 설정
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
# 별도 터미널
python3 -m http.server 5173 --bind 127.0.0.1 --directory frontend
```

`ALLOWED_ORIGINS=http://127.0.0.1:5173`과 `frontend/config.js`의
`API_BASE_URL=http://127.0.0.1:8000`을 일치시킵니다. 실제 Firebase·GPT 설정이 없어도
접근 코드 확인과 Swagger는 사용할 수 있으나 데이터·채팅 기능은 연결 설정이 필요합니다.

### Render 백엔드 준비

실제 배포는 이번 작업에서 수행하지 않습니다. 다음 단계에서 GitHub 저장소의 승인된
`main`을 Python Web Service로 연결합니다. 저장소 루트가 작업 디렉터리입니다.

- Python 3.12 런타임 사용(예: 서버 `PYTHON_VERSION=3.12.14`; 호스팅 지원 여부 확인)
- Build Command: `python -m pip install -r requirements.txt`
- Start Command: `python -m backend.run`
- Health Check Path: `/docs` (인증정보·Firestore·모델 연결 없이 열람 가능)
- `PORT`는 Render가 제공하며 시작 모듈이 `0.0.0.0:$PORT`에 연결합니다. 로컬 기본값은 8000입니다.

필요한 서버 환경 변수:

| 이름 | 용도 및 관리 위치 |
| --- | --- |
| `EVALUATION_ACCESS_CODE` | 비밀값, Render 서버 설정에만 직접 입력 |
| `FIREBASE_PROJECT_ID` | 실제 Firebase 프로젝트 ID |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | 비밀값, Render 서버 환경 변수에만 직접 입력 |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | 로컬 보안 파일 방식용. Render에서는 JSON 방식을 사용하고 비워 둠 |
| `OPENAI_API_KEY` | 비밀값, Render 서버 환경 변수에만 직접 입력 |
| `OPENAI_BASE_URL` | `https://copa.codyssey.kr/v1` |
| `OPENAI_MODEL` | `gpt-5.4-mini` |
| `ALLOWED_ORIGINS` | 실제 HTTPS Vercel origin. 여러 origin은 쉼표 구분, 경로·와일드카드 제외 |
| `PORT` | Render가 제공하는 수신 포트 |

Firebase는 기존 모듈을 사용하며 프로젝트 ID와 서비스 계정의 ID가 같아야 합니다.
실제 서비스 키·코드는 배포 플랫폼의 비공개 서버 환경 변수로만 관리합니다.
키 파일을 Git에 추가하거나 프론트엔드 배포 설정에 전달하지 않습니다.
무료 Web Service는 유휴 후 첫 요청의 초기 구동에 시간이 걸릴 수 있습니다.
첫 확인이 시간 초과되면 잠시 기다리거나 공개 `/docs`에서 서버 구동을 확인한 후
접근 코드를 다시 입력합니다. 구동·응답·무료 한도는 실제 배포 후 확인해야 합니다.

### Vercel 프론트엔드 준비

- Root Directory: `frontend`
- Framework Preset: Other, 빌드·설치 명령 없음, Output Directory: `.`
- `frontend/vercel.json`이 정적 설정과 공개 config.js의 캐시 방지를 제공합니다.
- `.vercelignore`로 테스트·스크린샷·node_modules를 배포 파일에서 제외합니다.
- **실제 Render HTTPS URL 입력 위치:** `frontend/config.js`의 `API_BASE_URL`.
  서버 origin만 넣고 `/api`는 붙이지 않습니다. 이 URL은 공개 정보입니다.
- **실제 Vercel HTTPS URL 입력 위치:** Render의 `ALLOWED_ORIGINS`.
  지정한 배포 origin과 정확히 일치시킵니다. 임의 preview origin을 와일드카드로 허용하지 않습니다.
- 브라우저에는 접근 코드를 사용자가 입력할 뿐 Firebase·OpenAI 키를 포함하지 않습니다.

### 배포 후 검증 체크리스트 (이번에는 미실행)

1. `/docs`, `/openapi.json`의 공개 열람 및 Swagger 인증 헤더 입력 확인.
2. 코드 누락·오류·서버 미설정은 401, 올바른 코드의 `/api/access`만 200인지 확인.
3. 실제 HTTPS origin과 인증 헤더의 CORS preflight, 새로고침 후 재입력 확인.
4. 승인된 테스트 범위에서 Firebase·GPT 호환성 및 데이터·대화·차트 기능 확인.
5. 로그·URL·공개 정적 파일에 비밀정보가 없는지 확인하고 무료 사용량·초기 구동 지연 확인.

이 절은 작업 07 당시의 단일 코드 설계입니다. 현재 정책은 상단 **작업 08-C2**를
따릅니다. 평가자는 새 질문과 자료 조회만, 관리자는 CRUD와 대화 기록 기능을 사용합니다.
코드가 유출되면 서버 환경 값을 바꾸고 참여자에게 재입력을 안내해야 합니다.
일반 공개 서비스의 인증·비용 보호를 대신하지 않습니다.

검증 명령은 `.venv/bin/python -m tests.run_offline`, `frontend/`의 `npm test`,
`npm run test:browser`입니다. 기존 테스트는 테스트 전용 표식을 헤더로 보내 실제 인증
검증을 통과하며 인증 함수를 우회하지 않습니다. 원격 서비스는 Mock으로 검증합니다.
실제 Render·Vercel 배포, Firebase·GPT 요청, 실제 코드·비밀키 입력은 수행하지 않았습니다.

## 브리 중심 UI 초안 (작업 07-C)

승인된 브리 브랜드 가이드의 하늘색·민트 바람 요정, 윙크와 체크리스트 포즈를
참고해 투명 배경 웹용 PNG(`frontend/assets/bree-welcome.png`)를 분리 제작했습니다.
원본의 단순 크롭이 아닌 이미지 편집 도구로 제작한 에셋이며, 최종 외형은 사용자
시각적 검토 대상입니다. 인사 화면의 큰 이미지와 답변의 작은 아바타에 같은 파일을
사용합니다. 이미지는 로컬 정적 파일이며 외부 이미지 서버를 요청하지 않습니다.
사용자 시각적 승인과 코드 검토 전에는 병합하거나 배포하지 마세요.

PC는 왼쪽 대화 기록과 중앙 채팅, 별도 기온 자료 화면으로 구성합니다. 모바일은
하단 대화/기록/데이터 내비게이션을 사용합니다. 채팅은 입력창을 고정한 한 개의 메시지
스크롤 영역으로 구성해 페이지와 채팅의 이중 스크롤을 줄이며, `visualViewport`와
`dvh`, 안전 영역을 고려합니다. 실제 기기 키보드는 미검증입니다.

첫 인사 "안녕하세요, 브리예요! 외출 준비, 같이 해볼까요?"는 UI 안내이며 API로 보내거나
대화 기록에 저장하지 않습니다. 추천 질문 2개는 과거 평균·최저·최고와 관측 추세에
관한 내용입니다. 클릭은 입력창만 채우고 직접 전송해야 모델 호출을 요청합니다.
대화 중 표시 이름은 브리이며 서버 응답 자체는 변경하지 않습니다. 백엔드 프롬프트와
API 계약은 그대로이므로 실제 모델의 브리 말투·답변 품질도 아직 검증하지 않았습니다.

기온 자료 화면에 기존 통계·추세·SVG·CRUD를 유지하고 날짜별 목록 탐색을 추가했습니다.
필터는 목록만 좁히며 원본 데이터·전체 그래프를 수정하거나 추가 API를 요청하지 않습니다.
접근 코드·로딩·오류·삭제 확인·재입력 정책은 유지합니다. 위젯은 실시간 날씨를 표시하지
않으며 모든 기온은 기존 서버 응답만 사용합니다.

기존 JavaScript·Python 테스트와 Mock 브라우저 테스트에 추천 질문의 무전송 동작,
첫 인사의 미저장, 대화 전환, 365건 탐색, 360px 폭과 짧은 뷰포트 입력창을 검증합니다.
추가 표정 에셋과 떠 있는 애니메이션은 후순위로 남겼고 reduced-motion 정책을
준비했습니다. 필수 기능 안정성과 승인된 캐릭터 반영을 우선합니다.

### 작업 07-D · 디자인 시안 반영

접근·채팅 화면은 시안 B, 데이터·그래프 화면은 시안 A를 기준으로 밝은 하늘색·민트
배경, 녹색 주요 버튼, 부드러운 카드와 말풍선을 통일했습니다. 공통 테마는
`frontend/theme.css`에 있습니다. 배경의 곡선은 장식이며 실제 날씨를 나타내지 않습니다.
브리 에셋, API·인증·데이터 계약을 유지합니다. 접근 화면에도 브리 이미지를 사용하며
PC 데이터 화면은 추가·수정 폼과 기록 목록을 나란히, 모바일은 세로로 배치합니다.
검증은 기존 오프라인 Python·JavaScript 및 Mock 브라우저 테스트를 사용합니다.
실제 Firebase·GPT·배포와 실기기 키보드는 미검증입니다. 기존 Draft PR #9에서
사용자의 화면 승인과 코드 검토를 기다리며 자동 병합하지 않습니다.

07-D 실행 결과: `.venv/bin/python -m tests.run_offline` 99개, `frontend/`의
`npm test` 11개, `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:browser`
14개 통과. Mock PC 1440×900·모바일 390×844 화면을 캡처하고 360px·짧은 뷰포트의
입력창, 코드 인증, 카드 배치, 365건 탐색과 CRUD·그래프 회귀를 검증했습니다.
