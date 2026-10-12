"""Run all tests while rejecting outbound socket and DNS operations.

Usage from the repository root: .venv/bin/python -m tests.run_offline
"""

import unittest
from pathlib import Path
from unittest.mock import patch


def main():
    root = Path(__file__).resolve().parents[1]
    with (
        patch("socket.socket.connect", side_effect=AssertionError("Network forbidden")) as connect,
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
