"""One application's shared rolling window; not a provider billing hard cap."""

import math
import os
import time
from collections import deque
from threading import Lock

from fastapi import HTTPException


class ChatRateLimiter:
    def __init__(self, limit=5, window_seconds=600, clock=time.monotonic):
        if limit <= 0 or window_seconds <= 0:
            raise ValueError("Chat rate limits must be positive integers.")
        self.limit = limit
        self.window_seconds = window_seconds
        self.clock = clock
        self.attempts = deque()
        self.lock = Lock()

    @classmethod
    def from_environment(cls):
        return cls(
            limit=int(os.getenv("GPT_RATE_LIMIT_REQUESTS") or "5"),
            window_seconds=int(os.getenv("GPT_RATE_LIMIT_WINDOW_SECONDS") or "600"),
        )

    def acquire(self):
        with self.lock:
            now = self.clock()
            while self.attempts and self.attempts[0] <= now - self.window_seconds:
                self.attempts.popleft()
            if len(self.attempts) >= self.limit:
                retry_after = max(1, math.ceil(self.attempts[0] + self.window_seconds - now))
                raise HTTPException(
                    status_code=429, detail="Chat request limit reached; try later.",
                    headers={"Retry-After": str(retry_after)},
                )
            # Reserve before the model call; never refund failures or timeouts.
            self.attempts.append(now)
