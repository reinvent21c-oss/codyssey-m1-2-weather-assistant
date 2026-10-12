import importlib
import io
import json
import os
import tempfile
import traceback
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch, sentinel

from backend import firebase


# Deliberately not a usable private key; Certificate is mocked in every test.
TEST_ACCOUNT = {
    "type": "service_account",
    "project_id": "test-source-project",
    "private_key": "TEST_ONLY_NOT_A_KEY",
    "client_email": "offline@example.invalid",
    "token_uri": "https://example.invalid/token",
}


class FirebaseTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {"FIREBASE_PROJECT_ID": "actual-target-project"}, clear=True))
        self.dotenv = self.enterContext(patch.object(firebase, "load_dotenv"))
        self.get_app = self.enterContext(patch.object(firebase.firebase_admin, "get_app", side_effect=ValueError))
        self.certificate = self.enterContext(patch.object(firebase.credentials, "Certificate", return_value=sentinel.credential))
        self.initialize = self.enterContext(patch.object(firebase.firebase_admin, "initialize_app", return_value=sentinel.app))
        self.client = self.enterContext(patch.object(firebase.firestore, "client", return_value=sentinel.client))

    def configure_json(self):
        os.environ["FIREBASE_SERVICE_ACCOUNT_JSON"] = json.dumps(TEST_ACCOUNT)

    def test_missing_credentials(self):
        with self.assertRaisesRegex(firebase.FirebaseConfigurationError, "Set FIREBASE_SERVICE_ACCOUNT"):
            firebase.get_firebase_app()
        self.initialize.assert_not_called()

    def test_missing_project_id(self):
        self.configure_json()
        del os.environ["FIREBASE_PROJECT_ID"]
        with self.assertRaisesRegex(firebase.FirebaseConfigurationError, "FIREBASE_PROJECT_ID is required"):
            firebase.get_firebase_app()
        self.initialize.assert_not_called()

    def test_malformed_json_does_not_fall_back_to_file(self):
        os.environ["FIREBASE_SERVICE_ACCOUNT_JSON"] = "invalid JSON"
        os.environ["FIREBASE_SERVICE_ACCOUNT_PATH"] = "must-not-be-read.json"
        with patch.object(Path, "read_text") as read:
            with self.assertRaisesRegex(firebase.FirebaseConfigurationError, "not valid JSON"):
                firebase.get_firebase_app()
            read.assert_not_called()
        self.initialize.assert_not_called()

    def test_invalid_structure(self):
        for value in ([], {}, {**TEST_ACCOUNT, "private_key": ""}, {**TEST_ACCOUNT, "type": "other"}):
            with self.subTest(value_type=type(value).__name__):
                os.environ["FIREBASE_SERVICE_ACCOUNT_JSON"] = json.dumps(value)
                with self.assertRaisesRegex(firebase.FirebaseConfigurationError, "invalid structure"):
                    firebase.get_firebase_app()
        self.certificate.assert_not_called()

    def test_json_initialization_and_priority(self):
        self.configure_json()
        os.environ["FIREBASE_SERVICE_ACCOUNT_PATH"] = "must-not-be-read.json"
        with patch.object(Path, "read_text") as read:
            self.assertIs(firebase.get_firebase_app(), sentinel.app)
            read.assert_not_called()
        self.certificate.assert_called_once_with(TEST_ACCOUNT)
        self.initialize.assert_called_once_with(
            sentinel.credential, options={"projectId": "actual-target-project"}, name=firebase.APP_NAME
        )
        self.dotenv.assert_called_once_with(dotenv_path=firebase._ENV_PATH, override=False)

    def test_file_initialization(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "offline.json"
            path.write_text(json.dumps(TEST_ACCOUNT), encoding="utf-8")
            os.environ["FIREBASE_SERVICE_ACCOUNT_PATH"] = str(path)
            self.assertIs(firebase.get_firebase_app(), sentinel.app)
        self.certificate.assert_called_once_with(TEST_ACCOUNT)

    def test_unreadable_file(self):
        os.environ["FIREBASE_SERVICE_ACCOUNT_PATH"] = "missing.json"
        with patch.object(Path, "read_text", side_effect=FileNotFoundError("sensitive-path")):
            with self.assertRaisesRegex(firebase.FirebaseConfigurationError, "Could not read") as caught:
                firebase.get_firebase_app()
        self.assertNotIn("sensitive-path", str(caught.exception))

    def test_repeated_calls_reuse_app(self):
        self.configure_json()
        self.get_app.side_effect = [ValueError(), sentinel.app]
        self.assertIs(firebase.get_firebase_app(), sentinel.app)
        self.assertIs(firebase.get_firebase_app(), sentinel.app)
        self.initialize.assert_called_once()
        self.certificate.assert_called_once()

    def test_concurrent_calls_initialize_once(self):
        self.configure_json()
        state = {"app": None}

        def lookup(name):
            if state["app"] is None:
                raise ValueError()
            return state["app"]

        def initialize(*args, **kwargs):
            state["app"] = sentinel.app
            return sentinel.app

        self.get_app.side_effect = lookup
        self.initialize.side_effect = initialize
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: firebase.get_firebase_app(), range(8)))
        self.assertTrue(all(result is sentinel.app for result in results))
        self.initialize.assert_called_once()

    def test_firestore_client(self):
        self.configure_json()
        self.assertIs(firebase.get_firestore_client(), sentinel.client)
        self.client.assert_called_once_with(app=sentinel.app, database_id="(default)")

    def test_import_has_no_initialization_or_configuration_side_effects(self):
        with patch("dotenv.load_dotenv") as load:
            importlib.reload(firebase)
            load.assert_not_called()
        self.dotenv.assert_not_called()
        self.get_app.assert_not_called()
        self.certificate.assert_not_called()
        self.initialize.assert_not_called()
        self.client.assert_not_called()

    def test_sensitive_errors_and_logs_are_suppressed(self):
        self.configure_json()
        sensitive = "TEST_ONLY_NOT_A_KEY"
        for operation in (self.certificate, self.initialize, self.client):
            with self.subTest(operation=operation):
                operation.side_effect = RuntimeError(sensitive)
                output = io.StringIO()
                with redirect_stdout(output), redirect_stderr(output), self.assertNoLogs():
                    try:
                        firebase.get_firestore_client()
                    except firebase.FirebaseConfigurationError as exc:
                        rendered = "".join(traceback.format_exception(exc))
                    else:
                        self.fail("Expected a sanitized configuration error")
                self.assertNotIn(sensitive, rendered)
                self.assertEqual(output.getvalue(), "")
                operation.side_effect = None


if __name__ == "__main__":
    unittest.main()
