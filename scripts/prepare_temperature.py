#!/usr/bin/env python3
"""Convert the preserved CP949 source to UTF-8 and validate Seoul daily data.

Run from any directory: python3 scripts/prepare_temperature.py
The source is never modified. Invalid data stops processing before output writes.
"""

import csv
import hashlib
import json
import sys
from collections import Counter
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data/raw/seoul_daily_temperature_2023_2026.csv"
OUTPUT = ROOT / "data/processed/seoul_daily_temperature_2025_2026.csv"
REPORT = ROOT / "data/processed/validation.json"
START = date(2025, 10, 1)
END = date(2026, 9, 30)


def prepare():
    raw = SOURCE.read_bytes()
    provenance = json.loads((SOURCE.parent / "source.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256(raw).hexdigest()
    if digest != provenance["sha256"]:
        raise ValueError("Source SHA-256 differs from the recorded original")
    records = []
    missing_temperatures = 0
    with SOURCE.open(encoding="cp949", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {"지점", "지점명", "일시", "평균기온(°C)"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("Required source columns are missing")
        for line, row in enumerate(reader, start=2):
            if row["지점"].strip() != "108":
                continue
            day = date.fromisoformat(row["일시"].strip())
            if not START <= day <= END:
                continue
            text = row["평균기온(°C)"].strip()
            if not text:
                missing_temperatures += 1
                continue
            try:
                temperature = Decimal(text)
            except InvalidOperation as exc:
                raise ValueError(f"Invalid temperature at source line {line}") from exc
            if not temperature.is_finite():
                raise ValueError(f"Non-finite temperature at source line {line}")
            records.append((day, temperature))
    counts = Counter(day for day, _ in records)
    expected = {START + timedelta(days=i) for i in range((END - START).days + 1)}
    duplicates = sum(count - 1 for count in counts.values())
    missing = sorted(expected - set(counts))
    if duplicates or missing or missing_temperatures or len(records) != 365:
        raise ValueError(
            f"Data validation failed: rows={len(records)}, duplicates={duplicates}, "
            f"missing_dates={[day.isoformat() for day in missing]}, "
            f"missing_temperatures={missing_temperatures}"
        )
    records.sort()
    values = [value for _, value in records]
    mean = sum(values) / Decimal(len(values))
    rounded_mean = mean.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    matches = rounded_mean == Decimal("14.24") and min(values) == Decimal("-9.7") and max(values) == Decimal("33.1")
    report = {
        "source_sha256": digest,
        "source_encoding": "cp949",
        "output_encoding": "utf-8",
        "station": 108,
        "start": START.isoformat(),
        "end": END.isoformat(),
        "rows": len(records),
        "duplicate_dates": duplicates,
        "missing_dates": len(missing),
        "missing_temperatures": missing_temperatures,
        "mean_celsius": str(mean),
        "mean_celsius_rounded": str(rounded_mean),
        "min_celsius": str(min(values)),
        "max_celsius": str(max(values)),
        "matches_expected_statistics": matches,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(["date", "value", "memo"])
        for day, value in records:
            writer.writerow([day.isoformat(), str(value), "서울 관측지점 108 평균기온(°C)"])
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not matches:
        print("Observed statistics differ from expectations; source values were preserved.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(prepare())
    except (OSError, ValueError, KeyError) as exc:
        print(f"Preparation failed: {exc}", file=sys.stderr)
        sys.exit(1)
