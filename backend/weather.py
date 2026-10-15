"""Seoul-only forecast adapter. No network until explicitly enabled by operator.

Modern Seoul uses UTC+09:00 without DST; use a named fixed offset so Windows
needs no external tzdata download. All dates in this service are today's Seoul date.
"""
import math
import os
import re
import time
from datetime import datetime, timedelta, timezone
from threading import Lock

import httpx
from fastapi import APIRouter, Request

SEOUL = timezone(timedelta(hours=9), "Asia/Seoul")
FIELDS = {"temperature_2m": ("°C", -90, 60), "precipitation_probability": ("%", 0, 100),
          "precipitation": ("mm", 0, 1000), "wind_speed_10m": ("m/s", 0, 150)}
router = APIRouter(prefix="/api", tags=["outing"])


class WeatherService:
    def __init__(self, *, enabled=None, now=None, monotonic=time.monotonic):
        self.enabled = os.getenv("LIVE_WEATHER_ENABLED", "").lower() == "true" if enabled is None else enabled
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.monotonic = monotonic
        self.lock = Lock()
        self.cache = None
        self.cache_day = None
        self.expires = 0
        self.retry_at = 0
        self.fetched_at = None

    def fetch(self, day):
        # Fixed destination and coordinates; never forward access headers or user URLs.
        with httpx.Client(timeout=5.0, follow_redirects=False, trust_env=False) as client:
            response = client.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude": 37.5665, "longitude": 126.9780, "timezone": "Asia/Seoul",
                "hourly": ",".join(FIELDS), "temperature_unit": "celsius",
                "precipitation_unit": "mm", "wind_speed_unit": "ms",
                "start_date": day, "end_date": (datetime.fromisoformat(day) + timedelta(days=1)).date().isoformat(),
            })
            response.raise_for_status()
            return response.json()

    def recommend(self, selected, *, cached_only=False):
        now = self.now().astimezone(SEOUL)
        result = {"status": "unavailable", "location": "서울", "timezone": "Asia/Seoul",
                  "requested_at": None, "forecast_at": None, "offset_minutes": None,
                  "fetched_at": None, "model_issued_at": None,
                  "source": "Open-Meteo", "source_url": "https://open-meteo.com/",
                  "weather": None, "clothing": None, "umbrella": None, "items": [], "reasons": [],
                  "message": "현재 날씨 정보 확인 불가. 잠시 후 다시 확인해 주세요."}
        if not isinstance(selected, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", selected):
            return {**result, "message": "현재 날씨 정보 확인 불가. 오늘 외출 시각을 HH:MM으로 입력해 주세요."}
        hour, minute = map(int, selected.split(":"))
        requested = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        result["requested_at"] = requested.isoformat()
        if requested < now:
            return {**result, "message": "현재 날씨 정보 확인 불가. 서울 기준 현재 이후의 오늘 시각을 선택해 주세요."}
        if not self.enabled:
            return {**result, "message": "현재 날씨 정보 확인 불가. 실제 날씨 API 검증 승인 대기 중입니다."}
        target = requested.replace(minute=0) + (timedelta(hours=1) if minute else timedelta())
        day = now.date().isoformat()
        try:
            with self.lock:
                tick = self.monotonic()
                if tick < self.retry_at:
                    return result
                if self.cache_day != day or self.cache is None or tick >= self.expires:
                    if cached_only:
                        return result
                    # Back off ten minutes after failures. Never use stale data.
                    self.cache = None
                    self.retry_at = tick + 600
                    body = self.fetch(day)
                    self.validate_structure(body)
                    self.cache = body
                    self.cache_day = day
                    self.fetched_at = self.now().astimezone(SEOUL).isoformat()
                    self.expires = self.monotonic() + 600
                    self.retry_at = 0
                body = self.cache
                fetched_at = self.fetched_at
            # Recheck after I/O: don't return yesterday's selection across midnight.
            if self.now().astimezone(SEOUL).date().isoformat() != day:
                return result
            hourly = body["hourly"]
            index = hourly["time"].index(target.strftime("%Y-%m-%dT%H:00"))
            values = {}
            for field, (_, low, high) in FIELDS.items():
                value = hourly[field][index]
                if type(value) not in (int, float) or not low <= value <= high or not math.isfinite(value):
                    return result
                values[field] = value
            clothing, umbrella, items, reasons = recommendations(values)
            return {**result, "status": "available", "message": "확인된 시간대별 예보를 참고했어요.",
                    "forecast_at": target.isoformat(), "offset_minutes": int((target - requested).total_seconds() / 60),
                    "fetched_at": fetched_at, "weather": values, "clothing": clothing,
                    "umbrella": umbrella, "items": items, "reasons": reasons}
        except (httpx.HTTPError, ValueError, TypeError, KeyError, IndexError):
            return result

    @staticmethod
    def validate_structure(body):
        if body["timezone"] != "Asia/Seoul" or body["utc_offset_seconds"] != 32400:
            raise ValueError("Unexpected timezone")
        hourly = body["hourly"]
        times = hourly["time"]
        if not isinstance(times, list) or not times or len(times) > 48:
            raise ValueError("Invalid forecast hours")
        if any(not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):00", value) for value in times):
            raise ValueError("Invalid timestamps")
        parsed = [datetime.fromisoformat(value) for value in times]
        if any(b <= a for a, b in zip(parsed, parsed[1:])):
            raise ValueError("Unordered forecast")
        for field, (unit, _, _) in FIELDS.items():
            if body["hourly_units"][field] != unit or not isinstance(hourly[field], list) or len(hourly[field]) != len(times):
                raise ValueError("Invalid units or incomplete arrays")


def recommendations(values):
    temperature = values["temperature_2m"]
    probability = values["precipitation_probability"]
    precipitation = values["precipitation"]
    wind = values["wind_speed_10m"]
    clothing = ("두꺼운 외투와 보온 옷을 겹쳐 입어요." if temperature < 5 else
                "따뜻한 외투를 챙겨요." if temperature < 12 else
                "가벼운 겉옷을 챙겨요." if temperature < 20 else
                "가벼운 옷과 벗기 쉬운 겉옷을 준비해요." if temperature < 28 else
                "통풍이 잘되는 가벼운 옷을 입어요.")
    wet = precipitation > 0 or probability >= 40
    umbrella = "우산을 챙겨요." if wet else "해당 예보의 강수 가능성은 낮아요. 이후 변화를 다시 확인해요."
    items = ["방수 가방 또는 방수 덮개"] if wet else ["휴대 물병"]
    if temperature < 5:
        items.append("목도리 또는 장갑")
    if temperature >= 28:
        items.append("여분의 마실 물")
    if wind >= 10:
        items.append("바람막이")
        umbrella += " 바람이 강할 때는 우산 사용에 주의하고 안전한 실내 이동을 고려해요."
    reasons = [f"예보 기온 {temperature:g} °C를 기준으로 옷차림을 골랐어요.",
               f"강수확률 {probability:g}%와 예보 강수량 {precipitation:g} mm는 서로 다른 지표예요.",
               f"예보 풍속은 {wind:g} m/s예요. 개인 체감은 다를 수 있어요."]
    return clothing, umbrella, items, reasons


@router.get("/outing-recommendation")
def outing_recommendation(request: Request, time: str = ""):
    return request.app.state.weather_service.recommend(time)
