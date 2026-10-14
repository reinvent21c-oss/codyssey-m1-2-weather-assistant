"""Render/local entry point: bind to PORT (default 8000), with no reload."""

import os

import uvicorn


def server_options():
    port = int(os.getenv("PORT", "8000"))
    if not 1 <= port <= 65535:
        raise ValueError("PORT must be between 1 and 65535")
    return {"host": "0.0.0.0", "port": port}


if __name__ == "__main__":
    uvicorn.run("backend.main:app", **server_options())
