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
