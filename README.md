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
