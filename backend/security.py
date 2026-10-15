"""Shared evaluation gate; no permissive fallback or credential logging."""

import hmac
import os
from typing import Annotated

from fastapi import Depends, HTTPException, Security
from fastapi.security import APIKeyHeader


access_header = APIKeyHeader(name="X-Evaluation-Code", scheme_name="EvaluationCode", auto_error=False)


def require_evaluation_code(code: Annotated[str | None, Security(access_header)]):
    expected = os.getenv("EVALUATION_ACCESS_CODE", "")
    admin = os.getenv("ADMIN_ACCESS_CODE", "")
    if expected.strip() and code:
        # An empty or identical admin code must never grant elevated access.
        if admin.strip() and not hmac.compare_digest(admin.encode(), expected.encode()):
            if hmac.compare_digest(code.encode(), admin.encode()):
                return "admin"
        if hmac.compare_digest(code.encode(), expected.encode()):
            return "evaluator"
    raise HTTPException(status_code=401, detail="Evaluation access denied.")


Role = Annotated[str, Depends(require_evaluation_code)]


def require_admin(role: Role):
    if role != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required.")
