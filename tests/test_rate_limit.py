"""Deterministic clock and concurrency tests; no sockets or external SDKs."""

import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from fastapi import HTTPException

from backend.rate_limit import ChatRateLimiter


class RateLimitTests(unittest.TestCase):
    def test_rolling_window_boundary_and_retry_after(self):
        now = [100.0]
        limiter = ChatRateLimiter(2, 10, clock=lambda: now[0])
        limiter.acquire()
        now[0] = 101.0
        limiter.acquire()
        now[0] = 109.5
        with self.assertRaises(HTTPException) as caught:
            limiter.acquire()
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.headers["Retry-After"], "1")
        now[0] = 110.0
        limiter.acquire()
        self.assertEqual(list(limiter.attempts), [101.0, 110.0])

    def test_concurrent_reservations_never_exceed_limit(self):
        limiter = ChatRateLimiter(5, 600, clock=lambda: 100.0)
        barrier = Barrier(20)

        def attempt(_):
            barrier.wait()
            try:
                limiter.acquire()
                return 200
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(max_workers=20) as pool:
            results = list(pool.map(attempt, range(20)))
        self.assertEqual(results.count(200), 5)
        self.assertEqual(results.count(429), 15)
        self.assertEqual(len(limiter.attempts), 5)

    def test_defaults_configuration_and_invalid_values(self):
        with patch.dict(os.environ, {}, clear=True):
            limiter = ChatRateLimiter.from_environment()
            self.assertEqual((limiter.limit, limiter.window_seconds), (5, 600))
            os.environ.update(GPT_RATE_LIMIT_REQUESTS="2", GPT_RATE_LIMIT_WINDOW_SECONDS="60")
            limiter = ChatRateLimiter.from_environment()
            self.assertEqual((limiter.limit, limiter.window_seconds), (2, 60))
            for name in ("GPT_RATE_LIMIT_REQUESTS", "GPT_RATE_LIMIT_WINDOW_SECONDS"):
                for value in ("0", "-1", "abc", "1.5"):
                    with self.subTest(name=name, value=value), patch.dict(os.environ, {name: value}):
                        with self.assertRaises(ValueError):
                            ChatRateLimiter.from_environment()
