"""No provider network: real HTTPX parsing/logging over MockTransport only."""
import logging
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import Mock, patch

import httpx

from backend.weather import WeatherService
from tests.test_weather import NOW, payload

KEY = "TEST_ONLY_WEATHERAPI_KEY_PRIVATE_SENTINEL"


def weatherapi_payload():
    days = []
    for offset in range(2):
        date = (NOW + timedelta(days=offset)).date().isoformat()
        days.append({"date": date, "hour": [
            {"time": f"{date} {hour:02}:00", "temp_c": 18, "chance_of_rain": 70,
             "precip_mm": 1.2, "wind_kph": 36}
            for hour in range(24)]})
    return {"location": {"tz_id": "Asia/Seoul"}, "forecast": {"forecastday": days}}


class WeatherAPIBackupTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {"WEATHERAPI_KEY": KEY}, clear=True))
        self.primary_status = 429
        self.backup_status = 200
        self.primary_body = payload()
        self.backup_body = weatherapi_payload()
        self.error_host = None
        self.invalid_json_host = None
        self.requests = []
        self.tick = Mock(return_value=100)
        self.clock = Mock(return_value=NOW)
        real_client = httpx.Client
        self.transport = httpx.MockTransport(self.handle)
        self.clients = self.enterContext(patch("backend.weather.httpx.Client", side_effect=lambda **options: real_client(transport=self.transport, **options)))

    def handle(self, request):
        self.requests.append(request)
        self.assertEqual(request.url.scheme, "https")
        self.assertNotIn("x-evaluation-code", request.headers)
        self.assertNotIn("authorization", request.headers)
        if request.url.host == self.error_host:
            raise httpx.ReadTimeout(KEY, request=request)
        if request.url.host == self.invalid_json_host:
            return httpx.Response(200, text=KEY)
        if request.url.host == "api.open-meteo.com":
            return httpx.Response(self.primary_status, json=self.primary_body)
        self.assertEqual(request.url.host, "api.weatherapi.com")
        self.assertEqual(request.url.path, "/v1/forecast.json")
        self.assertEqual(dict(request.url.params), {"key": KEY, "q": "37.5665,126.9780", "days": "2"})
        return httpx.Response(self.backup_status, json=self.backup_body)

    def service(self):
        return WeatherService(enabled=True, now=self.clock, monotonic=self.tick)

    def test_primary_success_does_not_call_backup_or_trust_provider_metadata(self):
        self.primary_status = 200
        self.primary_body["_provider"] = "weatherapi"
        result = self.service().recommend("11:00")
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["source"], "Open-Meteo")
        self.assertEqual(result["source_url"], "https://open-meteo.com/")
        self.assertEqual(result["weather"]["wind_speed_10m"], 4)
        self.assertEqual(len(self.requests), 1)
        self.assertNotIn("key", self.requests[0].url.params)

    def test_429_backup_success_mapping_source_and_transport(self):
        result = self.service().recommend("10:30")
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["source"], "WeatherAPI.com")
        self.assertEqual(result["source_url"], "https://www.weatherapi.com/")
        self.assertEqual(result["weather"], {"temperature_2m": 18, "precipitation_probability": 70, "precipitation": 1.2, "wind_speed_10m": 10})
        self.assertEqual(result["forecast_at"], "2026-10-15T11:00:00+09:00")
        self.assertEqual(result["offset_minutes"], 30)
        self.assertEqual(len(self.requests), 2)
        for call in self.clients.call_args_list:
            self.assertEqual(call.kwargs, {"timeout": 5.0, "follow_redirects": False, "trust_env": False})
        self.assertNotIn(KEY, str(result))
        self.assertNotIn("_provider", result)

    def test_unset_or_blank_key_keeps_original_429_behavior(self):
        for key in (None, "", "   "):
            with self.subTest(key_present=key is not None):
                self.requests.clear()
                if key is None:
                    os.environ.pop("WEATHERAPI_KEY", None)
                else:
                    os.environ["WEATHERAPI_KEY"] = key
                service = self.service()
                self.assertEqual(service.recommend("11:00")["status"], "unavailable")
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(service.retry_at, 700)

    def test_non_429_errors_and_invalid_primary_data_do_not_trigger_backup(self):
        for status in (301, 401, 403, 500, 503):
            with self.subTest(status=status):
                self.requests.clear(); self.primary_status = status
                self.assertEqual(self.service().recommend("11:00")["status"], "unavailable")
                self.assertEqual(len(self.requests), 1)
        self.primary_status = 200
        for failure in ("timeout", "invalid_json", "invalid_structure"):
            with self.subTest(failure=failure):
                self.requests.clear()
                self.error_host = "api.open-meteo.com" if failure == "timeout" else None
                self.invalid_json_host = "api.open-meteo.com" if failure == "invalid_json" else None
                self.primary_body = {} if failure == "invalid_structure" else payload()
                self.assertEqual(self.service().recommend("11:00")["status"], "unavailable")
                self.assertEqual(len(self.requests), 1)

    def test_both_providers_fail_without_stale_data_or_secret_logging(self):
        for failure in (401, 429, 503, "timeout", "invalid_json"):
            with self.subTest(failure=failure):
                self.requests.clear()
                self.backup_status = failure if isinstance(failure, int) else 200
                self.error_host = "api.weatherapi.com" if failure == "timeout" else None
                self.invalid_json_host = "api.weatherapi.com" if failure == "invalid_json" else None
                self.backup_body = {"error": {"message": KEY}}
                service = self.service()
                with self.assertLogs(level="INFO") as logs:
                    result = service.recommend("11:00")
                    service.recommend("12:00")
                self.assertEqual(result["status"], "unavailable")
                self.assertIsNone(result["weather"])
                self.assertIsNone(service.cache)
                self.assertEqual(service.retry_at, 700)
                self.assertEqual(len(self.requests), 2)
                self.assertIn("fallback_failed", " ".join(logs.output))
                self.assertIn("retry_suppressed", " ".join(logs.output))
                for record in logs.records:
                    self.assertNotIn(KEY, record.getMessage())
                    self.assertNotIn("forecast.json", record.getMessage())
                    self.assertIsNone(record.exc_info)
                self.assertNotIn(KEY, str(result))

    def test_backup_success_hides_key_from_httpx_info_and_cache(self):
        self.backup_body["untrusted_extra"] = KEY
        service = self.service()
        with self.assertLogs(level="INFO") as logs:
            result = service.recommend("11:00")
            logging.getLogger("httpx").info("unrelated library event")
        self.assertIn("fallback_success", " ".join(logs.output))
        self.assertNotIn(KEY, " ".join(logs.output))
        self.assertNotIn("forecast.json", " ".join(logs.output))
        self.assertNotIn(KEY, str(result))
        self.assertNotIn(KEY, str(service.cache))
        self.assertNotIn("api.open-meteo.com", " ".join(logs.output))
        self.assertIn("unrelated library event", " ".join(logs.output))

    def test_bad_backup_dates_times_and_missing_fields_are_rejected(self):
        mutations = [
            lambda b: b["location"].update(tz_id="UTC"),
            lambda b: b.pop("location"),
            lambda b: b["forecast"]["forecastday"].pop(),
            lambda b: b["forecast"]["forecastday"].reverse(),
            lambda b: b["forecast"]["forecastday"][0].update(date="2026-02-30"),
            lambda b: b["forecast"]["forecastday"][0]["hour"].pop(),
            lambda b: b["forecast"]["forecastday"][0]["hour"][11].update(time="2026-10-15 10:00"),
            lambda b: b["forecast"]["forecastday"][1]["hour"][0].update(time="2026-10-15 00:00"),
            lambda b: b["forecast"]["forecastday"][0]["hour"][11].pop("wind_kph"),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                self.backup_body = weatherapi_payload(); mutate(self.backup_body)
                service = self.service()
                self.assertEqual(service.recommend("11:00")["status"], "unavailable")
                self.assertIsNone(service.cache)
                self.assertEqual(service.retry_at, 700)

    def test_bad_numeric_values_are_never_coerced_or_filled(self):
        for field in ("temp_c", "chance_of_rain", "precip_mm", "wind_kph"):
            for value in (None, True, "0", -1000, 10**1000):
                with self.subTest(field=field, value_type=type(value).__name__):
                    self.backup_body = weatherapi_payload()
                    self.backup_body["forecast"]["forecastday"][0]["hour"][11][field] = value
                    self.assertEqual(self.service().recommend("11:00")["status"], "unavailable")
        for field, value in (("temp_c", 61), ("chance_of_rain", 101), ("precip_mm", -0.1), ("wind_kph", 541)):
            body = weatherapi_payload(); body["forecast"]["forecastday"][1]["hour"][0][field] = value
            with self.assertRaises(ValueError):
                WeatherService.normalize_weatherapi(body, "2026-10-15")
        # JSON parsers may accept non-standard constants; reject them too.
        for value in (float("nan"), float("inf")):
            body = weatherapi_payload(); body["forecast"]["forecastday"][0]["hour"][11]["temp_c"] = value
            with self.assertRaises(ValueError):
                WeatherService.normalize_weatherapi(body, "2026-10-15")

    def test_zero_negative_temperature_and_fractional_wind_conversion(self):
        hour = self.backup_body["forecast"]["forecastday"][0]["hour"][11]
        hour.update(temp_c=-2.5, chance_of_rain=0, precip_mm=0, wind_kph=3.6)
        result = self.service().recommend("11:00")
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["weather"], {"temperature_2m": -2.5, "precipitation_probability": 0, "precipitation": 0, "wind_speed_10m": 1})

    def test_next_day_midnight_is_preserved(self):
        self.clock.return_value = NOW.replace(hour=14)  # Seoul 23:00
        self.backup_body["forecast"]["forecastday"][1]["hour"][0]["temp_c"] = 12
        result = self.service().recommend("23:30")
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["forecast_at"], "2026-10-16T00:00:00+09:00")
        self.assertEqual(result["weather"]["temperature_2m"], 12)
        self.assertEqual(result["offset_minutes"], 30)

    def test_midnight_during_backup_io_does_not_serve_yesterdays_selection(self):
        self.clock.side_effect = [NOW.replace(hour=14), NOW.replace(hour=15), NOW.replace(hour=15)]
        self.assertEqual(self.service().recommend("23:30")["status"], "unavailable")

    def test_cache_expiry_and_cached_only_keep_provider_and_do_not_refetch(self):
        service = self.service()
        self.assertEqual(service.recommend("11:00", cached_only=True)["status"], "unavailable")
        self.assertEqual(self.requests, [])
        service.recommend("11:00")
        self.tick.return_value = 699
        result = service.recommend("11:00", cached_only=True)
        self.assertEqual(result["source"], "WeatherAPI.com")
        self.assertEqual(result["status"], "available")
        self.assertEqual(len(self.requests), 2)
        self.tick.return_value = 700
        self.assertEqual(service.recommend("11:00", cached_only=True)["status"], "unavailable")
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(service.recommend("11:00")["status"], "available")
        self.assertEqual(len(self.requests), 4)
        self.assertEqual(service.expires, 1300)

    def test_both_failed_retry_at_600_seconds_and_recovery(self):
        service = self.service(); self.backup_status = 503
        self.assertEqual(service.recommend("11:00")["status"], "unavailable")
        self.tick.return_value = 699; service.recommend("11:00")
        self.assertEqual(len(self.requests), 2)
        self.tick.return_value = 700; self.backup_status = 200
        self.assertEqual(service.recommend("11:00")["status"], "available")
        self.assertEqual(len(self.requests), 4)
        self.assertEqual(service.retry_at, 0)

    def test_expired_backup_cache_returns_to_primary_when_primary_recovers(self):
        service = self.service()
        self.assertEqual(service.recommend("11:00")["source"], "WeatherAPI.com")
        self.tick.return_value = 700
        self.primary_status = 200
        self.assertEqual(service.recommend("11:00")["source"], "Open-Meteo")
        self.assertEqual(len(self.requests), 3)

    def test_parallel_requests_share_one_primary_and_backup_pair(self):
        service = self.service()
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(service.recommend, ["11:00"] * 12))
        self.assertTrue(all(r["status"] == "available" and r["source"] == "WeatherAPI.com" for r in results))
        self.assertEqual(len(self.requests), 2)
