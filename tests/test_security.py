"""Evaluation gate tests keep authentication real and mock only services."""

import hmac
import os
import runpy
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, call, patch

from fastapi.testclient import TestClient

from backend.chat_routes import get_conversation_service, get_gpt_service, get_summary_service
from backend.conversation_schemas import ConversationDetail
from backend.main import create_app
from backend.routes import get_data_service
from backend.run import server_options
from backend.schemas import DataSummary, TemperatureTrend
from backend.gpt_service import ModelTimedOut, ModelUnavailable
from backend.rate_limit import ChatRateLimiter
from backend.services import StorageUnavailable


TEST_CODE = "TEST_ONLY_EVALUATION_CODE"
ADMIN_CODE = "TEST_ONLY_ADMIN_CODE"
DOCUMENT_ID = "11111111-1111-4111-8111-111111111111"


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {"EVALUATION_ACCESS_CODE": TEST_CODE, "ADMIN_ACCESS_CODE": ADMIN_CODE, "ALLOWED_ORIGINS": "https://ui.example.invalid"}, clear=True))
        self.enterContext(patch("backend.main.load_dotenv"))
        self.app = create_app()
        self.data = Mock()
        self.data.create.side_effect = lambda record: record
        self.data.update.side_effect = lambda document_id, record: record
        self.data.list_records.return_value = []
        self.data.summary.return_value = DataSummary(start_date=None, end_date=None, count=0, mean_value=None, max_value=None, min_value=None, trend=TemperatureTrend(status="insufficient_data"))
        self.conversations = Mock()
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        document = ConversationDetail(id=DOCUMENT_ID, created_at=now, updated_at=now, messages=[])
        self.conversations.create.return_value = document
        self.conversations.get.return_value = document
        self.conversations.list_conversations.return_value = []
        self.model = Mock()
        self.model.answer.return_value = "Mock reply"
        self.provider = Mock(return_value=self.data)
        self.app.dependency_overrides[get_data_service] = lambda: self.provider()
        self.app.dependency_overrides[get_summary_service] = lambda: self.data
        self.app.dependency_overrides[get_conversation_service] = lambda: self.conversations
        self.app.dependency_overrides[get_gpt_service] = lambda: self.model
        self.client = self.enterContext(TestClient(self.app))

    def requests(self):
        record = {"date": "2025-10-01", "value": 0, "memo": "Mock"}
        return [
            ("get", "/api/access", {}),
            ("post", "/api/data", {"json": record}), ("get", "/api/data", {}),
            ("get", "/api/data/summary", {}), ("put", "/api/data/2025-10-01", {"json": record}),
            ("delete", "/api/data/2025-10-01", {}), ("post", "/api/chat", {"json": {"question": "Mock"}}),
            ("post", "/api/conversations", {}), ("get", "/api/conversations", {}),
            ("get", "/api/conversations/" + DOCUMENT_ID, {}),
            ("delete", "/api/conversations/" + DOCUMENT_ID, {}),
        ]

    def test_missing_and_wrong_codes_block_every_api_before_service_calls(self):
        for headers in ({}, {"X-Evaluation-Code": "WRONG_TEST_CODE"}):
            for method, path, kwargs in self.requests():
                with self.subTest(method=method, path=path, supplied=bool(headers)):
                    response = getattr(self.client, method)(path, headers=headers, **kwargs)
                    self.assertEqual(response.status_code, 401)
                    self.assertEqual(response.json(), {"detail": "Evaluation access denied."})
                    self.assertNotIn(TEST_CODE, response.text)
        self.provider.assert_not_called()
        self.data.create.assert_not_called()
        self.conversations.create.assert_not_called()
        self.model.answer.assert_not_called()

    def test_admin_code_reaches_every_api(self):
        for method, path, kwargs in self.requests():
            with self.subTest(method=method, path=path):
                response = getattr(self.client, method)(path, headers={"X-Evaluation-Code": ADMIN_CODE}, **kwargs)
                self.assertIn(response.status_code, (200, 201))
                self.assertNotIn(TEST_CODE, response.text)

    def test_evaluator_can_read_data_and_save_only_new_question(self):
        headers = {"X-Evaluation-Code": TEST_CODE}
        for path in ("/api/data", "/api/data/summary"):
            self.assertEqual(self.client.get(path, headers=headers).status_code, 200)
        response = self.client.post("/api/chat", headers=headers, json={"question": "Mock"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["response"], "Mock reply")
        self.conversations.create.assert_called_once()
        pair = self.conversations.create.call_args.args[0]
        self.assertEqual([(message.role, message.content) for message in pair], [("user", "Mock"), ("assistant", "Mock reply")])
        self.conversations.get.assert_not_called()
        self.conversations.append_pair.assert_not_called()

    def test_evaluator_forbidden_operations_never_reach_providers(self):
        for method, path, kwargs in self.requests():
            if path in ("/api/access", "/api/data/summary") or (method == "get" and path == "/api/data") or path == "/api/chat":
                continue
            with self.subTest(method=method, path=path):
                self.assertEqual(getattr(self.client, method)(path, headers={"X-Evaluation-Code": TEST_CODE}, **kwargs).status_code, 403)
        for document_id in (DOCUMENT_ID, "22222222-2222-4222-8222-222222222222"):
            self.assertEqual(self.client.post("/api/chat", headers={"X-Evaluation-Code": TEST_CODE}, json={"question": "Mock", "conversation_id": document_id}).status_code, 403)
        self.provider.assert_not_called()
        self.data.assert_not_called()
        self.data.summary.assert_not_called()
        for method in ("create", "get", "delete", "append_pair", "list_conversations"):
            getattr(self.conversations, method).assert_not_called()
        self.model.answer.assert_not_called()

    def test_evaluator_denied_before_real_provider_initialization(self):
        with patch("backend.routes.get_firestore_client") as data_client, patch("backend.chat_routes.get_firestore_client") as chat_client, TestClient(create_app()) as client:
            for method, path, kwargs in self.requests():
                if path.startswith("/api/conversations") or method in ("put", "delete") or (method == "post" and path == "/api/data"):
                    self.assertEqual(getattr(client, method)(path, headers={"X-Evaluation-Code": TEST_CODE}, **kwargs).status_code, 403)
            self.assertEqual(client.post("/api/chat", headers={"X-Evaluation-Code": TEST_CODE}, json={"question": "q", "conversation_id": DOCUMENT_ID}).status_code, 403)
            data_client.assert_not_called()
            chat_client.assert_not_called()

    def test_admin_role_and_invalid_admin_configuration_fail_closed(self):
        self.assertEqual(self.client.get("/api/access", headers={"X-Evaluation-Code": ADMIN_CODE}).json(), {"authenticated": True, "role": "admin"})
        for code in (None, "", "   ", TEST_CODE):
            with self.subTest(admin_configuration=code):
                if code is None:
                    os.environ.pop("ADMIN_ACCESS_CODE", None)
                else:
                    os.environ["ADMIN_ACCESS_CODE"] = code
                self.assertEqual(self.client.get("/api/access", headers={"X-Evaluation-Code": TEST_CODE}).json()["role"], "evaluator")
                self.assertEqual(self.client.post("/api/data", headers={"X-Evaluation-Code": TEST_CODE}, json={"date": "2025-10-01", "value": 1, "memo": "Mock"}).status_code, 403)
                self.assertEqual(self.client.get("/api/access", headers={"X-Evaluation-Code": ADMIN_CODE}).status_code, 401)

    def test_gpt_limit_shared_by_roles_and_no_provider_call_after_limit(self):
        self.app.state.chat_limiter = ChatRateLimiter(limit=2, window_seconds=600)
        for code in (TEST_CODE, ADMIN_CODE):
            self.assertEqual(self.client.post("/api/chat", headers={"X-Evaluation-Code": code}, json={"question": "Mock"}).status_code, 200)
        response = self.client.post("/api/chat", headers={"X-Evaluation-Code": TEST_CODE}, json={"question": "Mock"})
        self.assertEqual(response.status_code, 429)
        self.assertGreater(int(response.headers["Retry-After"]), 0)
        self.assertEqual(self.model.answer.call_count, 2)
        self.assertEqual(self.conversations.create.call_count, 2)

    def test_model_and_storage_failures_keep_reserved_attempt(self):
        for failure, expected in ((ModelUnavailable(), 502), (ModelTimedOut(), 504), (None, 503)):
            with self.subTest(status=expected):
                self.app.state.chat_limiter = ChatRateLimiter(limit=1)
                self.model.answer.side_effect = failure
                self.conversations.create.side_effect = None if failure else StorageUnavailable()
                self.assertEqual(self.client.post("/api/chat", headers={"X-Evaluation-Code": TEST_CODE}, json={"question": "Mock"}).status_code, expected)
                before = self.model.answer.call_count
                self.assertEqual(self.client.post("/api/chat", headers={"X-Evaluation-Code": ADMIN_CODE}, json={"question": "Mock"}).status_code, 429)
                self.assertEqual(self.model.answer.call_count, before)

    def test_invalid_or_forbidden_chat_does_not_consume_quota(self):
        headers = {"X-Evaluation-Code": TEST_CODE}
        self.assertEqual(self.client.post("/api/chat", headers=headers, json={"question": ""}).status_code, 422)
        self.assertEqual(self.client.post("/api/chat", headers=headers, json={"question": "q", "conversation_id": DOCUMENT_ID}).status_code, 403)
        self.assertEqual(self.client.post("/api/chat", json={"question": "q"}).status_code, 401)
        self.assertEqual(len(self.app.state.chat_limiter.attempts), 0)

    def test_unauthorized_requests_never_initialize_real_provider_dependencies(self):
        with patch("backend.routes.get_firestore_client") as data_client, patch("backend.chat_routes.get_firestore_client") as chat_client, patch("backend.gpt_service.OpenAI") as model, TestClient(create_app()) as client:
            for method, path, kwargs in self.requests():
                self.assertEqual(getattr(client, method)(path, **kwargs).status_code, 401)
            data_client.assert_not_called()
            chat_client.assert_not_called()
            model.assert_not_called()

    def test_server_missing_empty_or_whitespace_code_fails_closed(self):
        for value in (None, "", "   "):
            with self.subTest(configured=bool(value)):
                if value is None:
                    os.environ.pop("EVALUATION_ACCESS_CODE", None)
                else:
                    os.environ["EVALUATION_ACCESS_CODE"] = value
                for method, path, kwargs in self.requests():
                    self.assertEqual(getattr(self.client, method)(path, headers={"X-Evaluation-Code": TEST_CODE}, **kwargs).status_code, 401)

    def test_constant_time_comparison_and_no_code_in_logs_or_urls(self):
        with patch("backend.security.hmac.compare_digest", wraps=hmac.compare_digest) as compare, self.assertLogs(level="INFO") as logs:
            response = self.client.get("/api/access", headers={"X-Evaluation-Code": TEST_CODE})
        self.assertIn(call(TEST_CODE.encode(), TEST_CODE.encode()), compare.call_args_list)
        self.assertEqual(response.json(), {"authenticated": True, "role": "evaluator"})
        self.assertNotIn(TEST_CODE, "\n".join(logs.output))
        self.assertNotIn(TEST_CODE, str(response.request.url))
        self.provider.assert_not_called()

    def test_cors_preflight_allows_code_header_without_code(self):
        response = self.client.options("/api/chat", headers={
            "Origin": "https://ui.example.invalid", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-evaluation-code",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], "https://ui.example.invalid")
        self.assertIn("x-evaluation-code", response.headers["access-control-allow-headers"].lower())
        denied = self.client.options("/api/chat", headers={"Origin": "https://other.example.invalid", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-evaluation-code"})
        self.assertEqual(denied.status_code, 400)

    def test_docs_public_and_openapi_security_for_all_operations(self):
        os.environ.pop("EVALUATION_ACCESS_CODE")
        self.assertEqual(self.client.get("/docs").status_code, 200)
        schema = self.client.get("/openapi.json").json()
        security = schema["components"]["securitySchemes"]["EvaluationCode"]
        self.assertEqual(security, {"type": "apiKey", "in": "header", "name": "X-Evaluation-Code"})
        for path, operations in schema["paths"].items():
            for operation in operations.values():
                self.assertIn({"EvaluationCode": []}, operation["security"])

    def test_server_port_options(self):
        self.assertEqual(server_options(), {"host": "0.0.0.0", "port": 8000})
        os.environ["PORT"] = "12345"
        self.assertEqual(server_options()["port"], 12345)
        for value in ("0", "65536", "not-a-port"):
            os.environ["PORT"] = value
            with self.assertRaises(ValueError):
                server_options()

    def test_render_entrypoint_passes_port_to_uvicorn_without_starting_server(self):
        os.environ["PORT"] = "12345"
        with patch("uvicorn.run") as run:
            runpy.run_path(str(Path(__file__).resolve().parents[1] / "backend/run.py"), run_name="__main__")
        run.assert_called_once_with("backend.main:app", host="0.0.0.0", port=12345)


if __name__ == "__main__":
    unittest.main()
