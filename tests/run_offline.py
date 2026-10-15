"""Run all tests while rejecting outbound socket and DNS operations.

Usage from the repository root: .venv/bin/python -m tests.run_offline
Windows: .\\.venv\\Scripts\\python.exe -m tests.run_offline
"""

import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


def main():
    root = Path(__file__).resolve().parents[1]
    real_connect = socket.socket.connect
    connect = Mock(side_effect=AssertionError("Network forbidden"))
    fallback = getattr(socket, "_fallback_socketpair", None)

    def guarded_connect(sock, address):
        # Windows asyncio needs socketpair's loopback self-pipe. Permit only
        # the stdlib fallback's own socket, never arbitrary localhost traffic.
        caller = sys._getframe(1)
        if (
            sys.platform == "win32"
            and fallback is not None
            and caller.f_code is fallback.__code__
            and sock is caller.f_locals.get("csock")
            and address == (caller.f_locals.get("addr"), caller.f_locals.get("port"))
            and address[0] in ("127.0.0.1", "::1")
        ):
            return real_connect(sock, address)
        return connect(sock, address)

    with (
        patch("socket.socket.connect", new=guarded_connect),
        patch("socket.socket.connect_ex", side_effect=AssertionError("Network forbidden")) as connect_ex,
        patch("socket.create_connection", side_effect=AssertionError("Network forbidden")) as create,
        patch("socket.getaddrinfo", side_effect=AssertionError("DNS forbidden")) as dns,
    ):
        suite = unittest.defaultTestLoader.discover(str(root / "tests"), top_level_dir=str(root))
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        # Even a caught network error would fail these assertions.
        for operation in (connect, connect_ex, create, dns):
            operation.assert_not_called()
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
