"""Lazy Firebase Admin initialization; importing this module needs no credentials."""

import json
import os
from pathlib import Path
from threading import Lock

import firebase_admin
from firebase_admin import credentials, firestore
from dotenv import load_dotenv


APP_NAME = "codyssey-weather-assistant-backend"
DATABASE_ID = "(default)"
_ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
_INIT_LOCK = Lock()


class FirebaseConfigurationError(RuntimeError):
    """Safe error message that never includes credential contents or SDK errors."""


def _read_configuration():
    try:
        load_dotenv(dotenv_path=_ENV_PATH, override=False)
    except Exception:
        raise FirebaseConfigurationError("Could not load local Firebase configuration.") from None

    project_id = os.getenv("FIREBASE_PROJECT_ID", "").strip()
    if not project_id:
        raise FirebaseConfigurationError("FIREBASE_PROJECT_ID is required; use the actual project ID.")

    inline_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    account_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "").strip()
    if inline_json:
        text = inline_json
    elif account_path:
        try:
            text = Path(account_path).expanduser().read_text(encoding="utf-8")
        except (OSError, ValueError):
            raise FirebaseConfigurationError("Could not read FIREBASE_SERVICE_ACCOUNT_PATH.") from None
    else:
        raise FirebaseConfigurationError(
            "Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH."
        )

    try:
        account = json.loads(text)
    except ValueError:
        raise FirebaseConfigurationError("Service account JSON is not valid JSON.") from None
    fields = ("project_id", "private_key", "client_email", "token_uri")
    if (
        not isinstance(account, dict)
        or account.get("type") != "service_account"
        or any(not isinstance(account.get(key), str) or not account[key].strip() for key in fields)
    ):
        raise FirebaseConfigurationError("Service account JSON has an invalid structure.")
    return project_id, account


def get_firebase_app():
    """Return one named app per process; initialize only on the first call.

    Nonempty inline JSON takes precedence over a file path. Invalid inline JSON
    fails explicitly instead of silently falling back to a different credential.
    Existing apps are reused; restart the process after changing configuration.
    """
    with _INIT_LOCK:
        try:
            return firebase_admin.get_app(APP_NAME)
        except ValueError:
            pass

        project_id, account = _read_configuration()
        try:
            credential = credentials.Certificate(account)
        except Exception:
            raise FirebaseConfigurationError("Service account credentials could not be loaded.") from None
        try:
            return firebase_admin.initialize_app(
                credential, options={"projectId": project_id}, name=APP_NAME
            )
        except Exception:
            raise FirebaseConfigurationError("Firebase app initialization failed.") from None


def get_firestore_client():
    """Return the Admin SDK client for (default); perform no document operations."""
    app = get_firebase_app()
    try:
        return firestore.client(app=app, database_id=DATABASE_ID)
    except Exception:
        raise FirebaseConfigurationError("Firestore client creation failed.") from None
