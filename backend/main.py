"""Local FastAPI app; creating the app does not initialize Firebase."""

import os
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.routes import router
from backend.chat_routes import router as chat_router
from backend.conversation_service import ConversationLimitReached, ConversationNotFound
from backend.gpt_service import ModelTimedOut, ModelUnavailable
from backend.services import DataNotFound, DuplicateData, StorageUnavailable


def allowed_origins():
    origins = []
    for item in os.getenv("ALLOWED_ORIGINS", "").split(","):
        origin = item.strip().rstrip("/")
        if not origin:
            continue
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
            or "*" in origin
        ):
            raise ValueError("ALLOWED_ORIGINS must contain explicit HTTP(S) origins.")
        if origin not in origins:
            origins.append(origin)
    return origins


def create_app():
    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
    app = FastAPI(title="오늘 뭐 챙기지? — 관측 기온 데이터 API")
    app.add_middleware(
        CORSMiddleware, allow_origins=allowed_origins(), allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type"],
    )
    app.include_router(router)
    app.include_router(chat_router)

    @app.exception_handler(ConversationNotFound)
    async def conversation_missing(request: Request, exc: ConversationNotFound):
        return JSONResponse(status_code=404, content={"detail": "Conversation not found."})

    @app.exception_handler(ConversationLimitReached)
    async def conversation_full(request: Request, exc: ConversationLimitReached):
        return JSONResponse(status_code=409, content={"detail": "Conversation limit reached; start a new conversation."})

    @app.exception_handler(ModelUnavailable)
    async def model_unavailable(request: Request, exc: ModelUnavailable):
        return JSONResponse(status_code=502, content={"detail": "AI response is unavailable."})

    @app.exception_handler(ModelTimedOut)
    async def model_timeout(request: Request, exc: ModelTimedOut):
        return JSONResponse(status_code=504, content={"detail": "AI request timed out."})

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        # Do not echo input/exception context: NaN/Infinity cannot be JSON encoded.
        errors = [
            {"loc": error["loc"], "msg": error["msg"], "type": error["type"]}
            for error in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": errors})

    @app.exception_handler(DuplicateData)
    async def duplicate_handler(request: Request, exc: DuplicateData):
        return JSONResponse(status_code=409, content={"detail": "Data for this date already exists."})

    @app.exception_handler(DataNotFound)
    async def missing_handler(request: Request, exc: DataNotFound):
        return JSONResponse(status_code=404, content={"detail": "Data document not found."})

    @app.exception_handler(StorageUnavailable)
    async def storage_handler(request: Request, exc: StorageUnavailable):
        return JSONResponse(status_code=503, content={"detail": "Data storage is unavailable."})

    return app


app = create_app()
