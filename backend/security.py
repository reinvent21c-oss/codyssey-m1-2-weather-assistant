"""Shared evaluation gate; no permissive fallback or credential logging."""

import hmac
import os
from typing import Annotated

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader


access_header = APIKeyHeader(name="X-Evaluation-Code", scheme_name="EvaluationCode", auto_error=False)


def require_evaluation_code(code: Annotated[str | None, Security(access_header)]):
    expected = os.getenv("EVALUATION_ACCESS_CODE", "")
    if not expected.strip() or not code or not hmac.compare_digest(code.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Evaluation access denied.")
