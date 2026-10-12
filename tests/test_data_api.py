"""In-process HTTP tests with a mocked Firestore client; no real credentials."""

import os
import unittest
from datetime import date, timedelta
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from google.api_core.exceptions import AlreadyExists, NotFound

from backend.main import create_app


class DataApiTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {"ALLOWED_ORIGINS": ""}, clear=True))
        self.enterContext(patch("backend.main.load_dotenv"))
        self.documents = {}
        self.firestore = Mock()
        self.collection = self.firestore.collection.return_value
        self.collection.document.side_effect = self.document
        self.collection.stream.side_effect = self.snapshots
        self.transaction = self.firestore.transaction.return_value
        self.transaction.delete.side_effect = lambda reference: self.documents.pop(reference.id)
        self.connection = self.enterContext(patch("backend.routes.get_firestore_client", return_value=self.firestore))
        self.transactional = self.enterContext(patch("backend.services.firestore.transactional", side_effect=lambda function: function))
        self.client = self.enterContext(TestClient(create_app()))

    def snapshot(self, document_id):
        result = Mock()
        result.id = document_id
        result.exists = document_id in self.documents
        result.to_dict.return_value = self.documents.get(document_id)
        return result

    def snapshots(self):
        return iter(self.snapshot(document_id) for document_id in self.documents)

    def document(self, document_id):
        reference = Mock()
        reference.id = document_id
        reference.get.side_effect = lambda **kwargs: self.snapshot(document_id)

        def create(payload):
            if document_id in self.documents:
                raise AlreadyExists("SDK internal error")
            self.documents[document_id] = payload.copy()

        def update(payload):
            if document_id not in self.documents:
                raise NotFound("SDK internal error")
            self.documents[document_id].update(payload)

        reference.create.side_effect = create
        reference.update.side_effect = update
        return reference

    def record(self, day="2025-10-01", value=20.5, memo="서울 관측지점 108 평균기온(°C)"):
        return {"date": day, "value": value, "memo": memo}

    def seed(self, day, value):
        self.documents[day] = self.record(day, value)

    def test_create_success(self):
        response = self.client.post("/api/data", json=self.record())
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json(), self.record())
        self.assertEqual(self.documents["2025-10-01"], self.record())
        self.firestore.collection.assert_called_with("data")

    def test_list_sorted_by_date(self):
        self.seed("2025-10-03", 3)
        self.seed("2025-10-01", -1)
        self.seed("2025-10-02", 0)
        response = self.client.get("/api/data")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["date"] for row in response.json()], ["2025-10-01", "2025-10-02", "2025-10-03"])

    def test_update_success(self):
        self.seed("2025-10-01", 1)
        payload = self.record(value=-9.7, memo="수정")
        response = self.client.put("/api/data/2025-10-01", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), payload)
        self.assertEqual(self.documents["2025-10-01"], payload)

    def test_delete_success_uses_transaction(self):
        self.seed("2025-10-01", 1)
        reference = self.document("2025-10-01")
        self.collection.document.side_effect = None
        self.collection.document.return_value = reference
        response = self.client.delete("/api/data/2025-10-01")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"id": "2025-10-01", "deleted": True})
        self.assertEqual(self.documents, {})
        reference.get.assert_called_once_with(transaction=self.transaction)
        self.transaction.delete.assert_called_once_with(reference)
        self.transactional.assert_called_once()

    def test_duplicate_create_returns_409_without_overwrite(self):
        self.seed("2025-10-01", 1)
        response = self.client.post("/api/data", json=self.record(value=2))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.documents["2025-10-01"]["value"], 1)
        self.assertNotIn("SDK internal error", response.text)

    def test_update_missing_returns_404(self):
        response = self.client.put("/api/data/2025-10-01", json=self.record())
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.documents, {})

    def test_delete_missing_returns_404(self):
        response = self.client.delete("/api/data/2025-10-01")
        self.assertEqual(response.status_code, 404)
        self.transaction.delete.assert_not_called()

    def test_update_date_mismatch_returns_422(self):
        self.seed("2025-10-01", 1)
        response = self.client.put("/api/data/2025-10-01", json=self.record(day="2025-10-02"))
        self.assertEqual(response.status_code, 422)
        self.assertIn("must match", response.json()["detail"])
        self.assertEqual(self.documents["2025-10-01"]["value"], 1)

    def test_invalid_dates_numbers_and_memos(self):
        invalid = [
            {"date": "2025-02-30"}, {"date": "2025-1-01"}, {"date": "2025-10-01T00:00:00"},
            {"date": 20251001}, {"value": "20.5"}, {"value": True}, {"value": None},
            {"memo": 12}, {"memo": None}, {"unexpected": "field"},
        ]
        for changes in invalid:
            with self.subTest(changes=changes):
                response = self.client.post("/api/data", json={**self.record(), **changes})
                self.assertEqual(response.status_code, 422)
        for number in ("NaN", "Infinity", "-Infinity", "1e999"):
            with self.subTest(number=number):
                response = self.client.post(
                    "/api/data", content='{"date":"2025-10-01","value":' + number + ',"memo":""}',
                    headers={"Content-Type": "application/json"},
                )
                self.assertEqual(response.status_code, 422)
        self.assertEqual(self.documents, {})

    def test_invalid_path_dates(self):
        for path in ("not-a-date", "2025-02-30", "2025-1-01"):
            with self.subTest(path=path):
                self.assertEqual(self.client.delete("/api/data/" + path).status_code, 422)

    def test_zero_negative_and_leap_date_are_valid(self):
        for day, value in (("2024-02-29", 0), ("2025-10-01", -9.7)):
            with self.subTest(day=day):
                self.assertEqual(self.client.post("/api/data", json=self.record(day, value)).status_code, 201)

    def test_summary_calculates_statistics(self):
        self.seed("2025-10-03", 30)
        self.seed("2025-10-01", -10)
        self.seed("2025-10-02", 10)
        response = self.client.get("/api/data/summary")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual((data["start_date"], data["end_date"], data["count"]), ("2025-10-01", "2025-10-03", 3))
        self.assertEqual((data["mean_value"], data["min_value"], data["max_value"]), (10, -10, 30))
        self.assertEqual(data["trend"]["status"], "insufficient_data")

    def test_trend_rising_falling_stable_and_boundaries(self):
        for delta, expected in ((0.5, "rising"), (-0.5, "falling"), (0.49, "stable"), (-0.49, "stable"), (0, "stable")):
            with self.subTest(delta=delta):
                self.documents.clear()
                for index in range(14):
                    day = (date(2025, 10, 1) + timedelta(days=index)).isoformat()
                    self.seed(day, 10 if index < 7 else 10 + delta)
                data = self.client.get("/api/data/summary").json()
                self.assertEqual(data["trend"]["status"], expected)
                self.assertEqual(data["trend"]["latest_week_mean"], 10 + delta)
                self.assertEqual(data["trend"]["previous_week_mean"], 10)
                self.assertEqual(data["trend"]["threshold_celsius"], 0.5)

    def test_trend_uses_last_observed_date_not_today(self):
        for index in range(21):
            day = (date(2000, 1, 1) + timedelta(days=index)).isoformat()
            self.seed(day, 100 if index < 7 else 10 if index < 14 else 12)
        data = self.client.get("/api/data/summary").json()
        self.assertEqual(data["end_date"], "2000-01-21")
        self.assertEqual(data["trend"]["status"], "rising")
        self.assertEqual(data["trend"]["latest_week_mean"], 12)
        self.assertEqual(data["trend"]["previous_week_mean"], 10)

    def test_empty_list_and_summary(self):
        self.assertEqual(self.client.get("/api/data").json(), [])
        response = self.client.get("/api/data/summary")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["count"], 0)
        for key in ("start_date", "end_date", "mean_value", "min_value", "max_value"):
            self.assertIsNone(data[key])
        self.assertEqual(data["trend"]["status"], "insufficient_data")

    def test_trend_with_missing_calendar_day_is_insufficient(self):
        for index in range(15):
            if index != 8:
                self.seed((date(2025, 10, 1) + timedelta(days=index)).isoformat(), index)
        data = self.client.get("/api/data/summary").json()
        self.assertEqual(data["count"], 14)
        self.assertEqual(data["trend"]["status"], "insufficient_data")

    def test_extreme_finite_values_do_not_overflow_statistics(self):
        for index in range(14):
            self.seed((date(2025, 10, 1) + timedelta(days=index)).isoformat(), -1e308 if index < 7 else 1e308)
        response = self.client.get("/api/data/summary")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["trend"]["status"], "rising")
        self.assertEqual(response.json()["mean_value"], 0)

    def test_earliest_supported_date_is_insufficient_without_error(self):
        self.seed("0001-01-01", 1)
        response = self.client.get("/api/data/summary")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["trend"]["status"], "insufficient_data")

    def test_firestore_errors_are_safe_503_for_all_operations(self):
        self.collection.document.side_effect = RuntimeError("INTERNAL_CREDENTIAL_DETAIL")
        self.collection.stream.side_effect = RuntimeError("INTERNAL_CREDENTIAL_DETAIL")
        requests = [
            ("post", "/api/data", {"json": self.record()}),
            ("get", "/api/data", {}), ("get", "/api/data/summary", {}),
            ("put", "/api/data/2025-10-01", {"json": self.record()}),
            ("delete", "/api/data/2025-10-01", {}),
        ]
        for method, path, kwargs in requests:
            with self.subTest(method=method, path=path):
                response = getattr(self.client, method)(path, **kwargs)
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"detail": "Data storage is unavailable."})
                self.assertNotIn("INTERNAL_CREDENTIAL_DETAIL", response.text)

    def test_connection_errors_are_safe_503(self):
        self.connection.side_effect = RuntimeError("INTERNAL_CREDENTIAL_DETAIL")
        response = self.client.get("/api/data")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("INTERNAL_CREDENTIAL_DETAIL", response.text)

    def test_corrupt_stored_records_return_safe_503(self):
        self.documents["2025-10-01"] = self.record(day="2025-10-02")
        self.assertEqual(self.client.get("/api/data").status_code, 503)
        self.documents["2025-10-01"] = self.record(value="invalid")
        self.assertEqual(self.client.get("/api/data/summary").status_code, 503)

    def test_docs_and_openapi_without_firestore_initialization(self):
        docs = self.client.get("/docs")
        self.assertEqual(docs.status_code, 200)
        self.assertIn("swagger-ui", docs.text)
        schema = self.client.get("/openapi.json")
        self.assertEqual(schema.status_code, 200)
        self.assertEqual(set(schema.json()["paths"]), {"/api/data", "/api/data/{id}", "/api/data/summary"})
        self.assertEqual(set(schema.json()["paths"]["/api/data"]), {"post", "get"})
        self.assertEqual(set(schema.json()["paths"]["/api/data/{id}"]), {"put", "delete"})
        self.connection.assert_not_called()

    def test_cors_explicit_origins_only(self):
        os.environ["ALLOWED_ORIGINS"] = "http://localhost:5173"
        with TestClient(create_app()) as client:
            for origin, expected in (("http://localhost:5173", 200), ("https://untrusted.example", 400)):
                with self.subTest(origin=origin):
                    response = client.options("/api/data", headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
                    self.assertEqual(response.status_code, expected)
                    if expected == 200:
                        self.assertEqual(response.headers["access-control-allow-origin"], origin)
                    else:
                        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_cors_default_denies_cross_origin(self):
        response = self.client.options("/api/data", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_cors_wildcard_is_rejected(self):
        for origin in ("*", "https://*.example.com", "https://example.com/path"):
            with self.subTest(origin=origin):
                os.environ["ALLOWED_ORIGINS"] = origin
                with self.assertRaisesRegex(ValueError, "explicit HTTP"):
                    create_app()


if __name__ == "__main__":
    unittest.main()
