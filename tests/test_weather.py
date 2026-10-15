"""Offline weather contract: all provider responses are mocked."""
import copy
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock, patch

import httpx
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.weather import WeatherService

NOW = datetime(2026, 10, 15, 1, 0, tzinfo=timezone.utc)  # Seoul 10:00


def payload():
    times = [f"2026-10-15T{h:02}:00" for h in range(24)] + ["2026-10-16T00:00"]
    return {"timezone": "Asia/Seoul", "utc_offset_seconds": 32400,
            "hourly_units": {"temperature_2m": "°C", "precipitation_probability": "%", "precipitation": "mm", "wind_speed_10m": "m/s"},
            "hourly": {"time": times, "temperature_2m": [18] * 25,
                       "precipitation_probability": [70] * 25, "precipitation": [1.2] * 25,
                       "wind_speed_10m": [4] * 25}}


class WeatherTests(unittest.TestCase):
    def setUp(self):
        self.body = payload()
        self.clock = Mock(return_value=NOW)
        self.monotonic = Mock(return_value=100)
        self.fetch = Mock(side_effect=lambda date: copy.deepcopy(self.body))
        self.service = WeatherService(enabled=True, now=self.clock, monotonic=self.monotonic)
        self.service.fetch = self.fetch

    def test_rain_and_mapping(self):
        result = self.service.recommend("10:30")
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["forecast_at"], "2026-10-15T11:00:00+09:00")
        self.assertEqual(result["offset_minutes"], 30)
        self.assertIn("우산", result["umbrella"])
        self.assertEqual(result["weather"]["precipitation"], 1.2)
        self.assertEqual(result["weather"]["precipitation_probability"], 70)

    def test_zero_is_valid_and_no_rain_is_not_clear_sky(self):
        for key in ("temperature_2m", "precipitation_probability", "precipitation", "wind_speed_10m"):
            self.body["hourly"][key] = [0] * 25
        result = self.service.recommend("11:00")
        self.assertEqual(result["status"], "available")
        self.assertIn("낮", result["umbrella"])
        self.assertNotIn("맑", str(result))
        self.assertEqual(result["weather"]["temperature_2m"], 0)

    def test_invalid_missing_and_boolean_values_never_become_zero(self):
        for value in (None, True, "18", float("nan"), float("inf"), -1000):
            for key in ("temperature_2m", "precipitation_probability", "precipitation", "wind_speed_10m"):
                with self.subTest(key=key, value=str(value)):
                    service = WeatherService(enabled=True, now=self.clock)
                    body = payload(); body["hourly"][key][11] = value
                    service.fetch = Mock(return_value=body)
                    result = service.recommend("10:30")
                    self.assertEqual(result["status"], "unavailable")
                    self.assertIsNone(result["weather"])
                    self.assertIsNone(result["clothing"])

    def test_malformed_provider_responses(self):
        bodies = [{}, {"hourly": {}}, payload(), payload(), payload(), payload()]
        bodies[2]["timezone"] = "UTC"
        bodies[3]["hourly_units"]["wind_speed_10m"] = "km/h"
        bodies[4]["hourly"]["time"] = []
        bodies[5]["hourly"]["time"][11] = "2026-10-15T10:00"
        for body in bodies:
            with self.subTest(body_type=list(body)):
                service = WeatherService(enabled=True, now=self.clock)
                service.fetch = Mock(return_value=body)
                self.assertEqual(service.recommend("10:30")["status"], "unavailable")

    def test_past_and_invalid_times_do_not_fetch(self):
        for time in ("09:59", "24:00", "9:00", "11:60", "", "tomorrow"):
            self.assertEqual(self.service.recommend(time)["status"], "unavailable")
        self.fetch.assert_not_called()

    def test_current_minute_but_past_seconds_is_rejected(self):
        self.clock.return_value = NOW.replace(second=1)
        self.assertEqual(self.service.recommend("10:00")["status"], "unavailable")
        self.fetch.assert_not_called()

    def test_today_in_seoul_and_midnight_mapping(self):
        self.clock.return_value = datetime(2026, 10, 15, 14, 0, tzinfo=timezone.utc)
        result = self.service.recommend("23:30")
        self.assertEqual(result["requested_at"], "2026-10-15T23:30:00+09:00")
        self.assertEqual(result["forecast_at"], "2026-10-16T00:00:00+09:00")
        self.clock.return_value = datetime(2026, 10, 15, 15, 0, tzinfo=timezone.utc)
        self.assertEqual(self.service.recommend("00:00")["requested_at"], "2026-10-16T00:00:00+09:00")
        self.assertEqual(self.fetch.call_count, 2)

    def test_cache_expiry_failure_backoff_and_no_stale_fallback(self):
        self.assertEqual(self.service.recommend("11:00")["status"], "available")
        self.service.recommend("12:00"); self.fetch.assert_called_once()
        self.monotonic.return_value = 701
        self.fetch.side_effect = httpx.ReadTimeout("PRIVATE_SENTINEL")
        result = self.service.recommend("11:00")
        self.assertEqual(result["status"], "unavailable")
        self.assertNotIn("PRIVATE_SENTINEL", str(result))
        self.service.recommend("12:00"); self.assertEqual(self.fetch.call_count, 2)

    def test_disabled_never_fetches(self):
        service = WeatherService(enabled=False, now=self.clock)
        service.fetch = Mock()
        self.assertEqual(service.recommend("11:00")["status"], "unavailable")
        service.fetch.assert_not_called()

    def test_transport_is_fixed_bounded_and_no_redirects(self):
        response = Mock(); response.json.return_value = payload()
        with patch("backend.weather.httpx.Client") as client:
            client.return_value.__enter__.return_value.get.return_value = response
            WeatherService(enabled=True).fetch("2026-10-15")
        self.assertEqual(client.call_args.kwargs, {"timeout": 5.0, "follow_redirects": False, "trust_env": False})
        call = client.return_value.__enter__.return_value.get.call_args
        self.assertEqual(call.args[0], "https://api.open-meteo.com/v1/forecast")
        self.assertEqual(call.kwargs["params"]["timezone"], "Asia/Seoul")
        self.assertEqual(call.kwargs["params"]["wind_speed_unit"], "ms")

    def test_route_authenticates_before_provider_for_both_roles(self):
        with patch.dict(os.environ, {"EVALUATION_ACCESS_CODE": "TEST_ONLY_EVALUATOR", "ADMIN_ACCESS_CODE": "TEST_ONLY_ADMIN"}, clear=True), patch("backend.main.load_dotenv"):
            app = create_app(); app.state.weather_service = self.service
            with TestClient(app) as client:
                for headers in ({}, {"X-Evaluation-Code": "wrong"}):
                    self.assertEqual(client.get("/api/outing-recommendation?time=11:00", headers=headers).status_code, 401)
                self.fetch.assert_not_called()
                for code in ("TEST_ONLY_EVALUATOR", "TEST_ONLY_ADMIN"):
                    result = client.get("/api/outing-recommendation?time=11:00", headers={"X-Evaluation-Code": code})
                    self.assertEqual(result.status_code, 200)
                    self.assertEqual(result.json()["status"], "available")
                self.assertEqual(client.get("/api/outing-recommendation?time=bad", headers={"X-Evaluation-Code": code}).json()["status"], "unavailable")

    def test_probability_and_quantity_are_independent(self):
        for probability, precipitation in ((80, 0), (0, 0.1)):
            service = WeatherService(enabled=True, now=self.clock)
            body = payload()
            body["hourly"]["precipitation_probability"] = [probability] * 25
            body["hourly"]["precipitation"] = [precipitation] * 25
            service.fetch = Mock(return_value=body)
            self.assertIn("우산", service.recommend("11:00")["umbrella"])

    def test_missing_field_wrong_array_length_and_out_of_range(self):
        for mutation in (lambda body: body["hourly"].pop("precipitation"),
                         lambda body: body["hourly"]["precipitation"].pop(),
                         lambda body: body["hourly"].update(precipitation_probability=[101] * 25),
                         lambda body: body["hourly"].update(temperature_2m=[10**1000] * 25)):
            body = payload(); mutation(body)
            service = WeatherService(enabled=True, now=self.clock); service.fetch = Mock(return_value=body)
            self.assertEqual(service.recommend("11:00")["status"], "unavailable")

    def test_missing_requested_hour_and_no_next_day_midnight(self):
        self.body["hourly"]["time"][11] = "2026-10-15T11:30"
        self.assertEqual(self.service.recommend("10:30")["status"], "unavailable")
        service = WeatherService(enabled=True, now=lambda: NOW.replace(hour=14))
        body = payload()
        for values in body["hourly"].values():
            values.pop()
        service.fetch = Mock(return_value=body)
        self.assertEqual(service.recommend("23:30")["status"], "unavailable")

    def test_midnight_during_io_returns_unavailable(self):
        self.clock.side_effect = [datetime(2026, 10, 15, 14, 59, tzinfo=timezone.utc),
                                  datetime(2026, 10, 15, 15, 0, tzinfo=timezone.utc),
                                  datetime(2026, 10, 15, 15, 0, tzinfo=timezone.utc)]
        self.assertEqual(self.service.recommend("23:59")["status"], "unavailable")

    def test_cached_only_never_fetches_expired_or_missing_data(self):
        self.assertEqual(self.service.recommend("11:00", cached_only=True)["status"], "unavailable")
        self.fetch.assert_not_called()
        self.service.recommend("11:00")
        self.assertEqual(self.service.recommend("11:00", cached_only=True)["status"], "available")
        self.monotonic.return_value = 701
        self.assertEqual(self.service.recommend("11:00", cached_only=True)["status"], "unavailable")
        self.fetch.assert_called_once()

    def test_parallel_requests_share_one_provider_fetch(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(self.service.recommend, ["11:00"] * 12))
        self.assertTrue(all(result["status"] == "available" for result in results))
        self.fetch.assert_called_once()

    def test_provider_http_error_and_timeout_never_expose_details(self):
        for error in (httpx.ReadTimeout("PRIVATE_SENTINEL"),
                      httpx.HTTPStatusError("PRIVATE_SENTINEL", request=Mock(), response=Mock())):
            service = WeatherService(enabled=True, now=self.clock); service.fetch = Mock(side_effect=error)
            result = service.recommend("11:00")
            self.assertEqual(result["status"], "unavailable")
            self.assertNotIn("PRIVATE_SENTINEL", str(result))
