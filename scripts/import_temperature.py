"""Validate locally by default; remote operations require explicit CLI options."""

import argparse
import csv
import hashlib
import json
import os
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.schemas import DataRecord


CSV_PATH = ROOT / "data/processed/seoul_daily_temperature_2025_2026.csv"
VALIDATION_PATH = ROOT / "data/processed/validation.json"
RAW_PATH = ROOT / "data/raw/seoul_daily_temperature_2023_2026.csv"
START = date(2025, 10, 1)
END = date(2026, 9, 30)


class InputValidationError(ValueError):
    """Only fixed, safe messages; never include input contents."""


def validate_csv(csv_path=CSV_PATH, validation_path=VALIDATION_PATH):
    """Validate the entire input before any Firebase initialization or operation."""
    records = []
    temperatures = []
    try:
        with Path(csv_path).open(encoding="utf-8", newline="") as stream:
            reader = csv.DictReader(stream, strict=True)
            if reader.fieldnames != ["date", "value", "memo"]:
                raise InputValidationError("CSV columns must be exactly date,value,memo.")
            for row in reader:
                if set(row) != {"date", "value", "memo"} or any(value is None for value in row.values()):
                    raise InputValidationError("CSV row has missing or extra fields.")
                temperature = Decimal(row["value"])
                if not temperature.is_finite():
                    raise InputValidationError("CSV contains a non-finite temperature.")
                records.append(DataRecord.model_validate({**row, "value": float(temperature)}))
                temperatures.append(temperature)
        report = json.loads(Path(validation_path).read_text(encoding="utf-8"))
        raw_digest = hashlib.sha256(RAW_PATH.read_bytes()).hexdigest()
    except InputValidationError:
        raise
    except Exception:
        raise InputValidationError("Could not validate UTF-8 CSV, values, or validation report.") from None

    days = [record.date for record in records]
    expected_days = {(START + timedelta(days=index)).isoformat() for index in range(365)}
    if len(records) != 365 or any(count != 1 for count in Counter(days).values()) or set(days) != expected_days:
        raise InputValidationError("CSV must contain exactly 365 unique dates in the required period, without gaps.")
    if min(temperatures) != Decimal("-9.7") or max(temperatures) != Decimal("33.1"):
        raise InputValidationError("CSV temperature statistics differ from the expected dataset.")
    mean = sum(temperatures) / Decimal(365)
    rounded = mean.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if rounded != Decimal("14.24"):
        raise InputValidationError("CSV temperature statistics differ from the expected dataset.")
    observed = {
        "source_sha256": raw_digest, "source_encoding": "cp949", "output_encoding": "utf-8",
        "station": 108, "start": START.isoformat(), "end": END.isoformat(), "rows": 365,
        "duplicate_dates": 0, "missing_dates": 0, "missing_temperatures": 0,
        "mean_celsius": str(mean), "mean_celsius_rounded": str(rounded),
        "min_celsius": str(min(temperatures)), "max_celsius": str(max(temperatures)),
        "matches_expected_statistics": True,
    }
    if report != observed:
        raise InputValidationError("Computed validation differs from validation.json; import is blocked.")
    return sorted(records, key=lambda record: record.date), observed


@dataclass
class RemoteResult:
    mode: str
    project_id: str
    total: int
    collection: str = "data"
    created: int = 0
    existing_identical: int = 0
    conflicts: int = 0
    failed: int = 0
    pending: int = 0
    conflict_dates: list[str] = field(default_factory=list)
    failed_dates: list[str] = field(default_factory=list)
    status: str = "ready"


def connect_target(expected_project_id):
    """Check environment, initialized app, and client targets before remote reads."""
    from dotenv import load_dotenv
    from backend import firebase

    try:
        load_dotenv(ROOT / ".env", override=False)
        if os.getenv("FIREBASE_PROJECT_ID", "").strip() != expected_project_id:
            raise ValueError()
        app = firebase.get_firebase_app()
        if app.project_id != expected_project_id:
            raise ValueError()
        client = firebase.get_firestore_client()
        if client.project != expected_project_id:
            raise ValueError()
        return client
    except Exception:
        raise InputValidationError("Firebase target or configuration check failed; no remote data operations started.") from None


def _identical(snapshot, record):
    try:
        return snapshot.exists and DataRecord.model_validate(snapshot.to_dict()) == record
    except Exception:
        return False


def inspect_or_import(records, client, expected_project_id, *, apply=False, confirmed_project_id=None):
    """Read all target dates before writing; create missing dates without overwrite.

    Callers must validate the entire CSV first. Tests pass a mocked client only.
    An uncertain write failure stops the run: a rerun reconciles committed data.
    """
    if client.project != expected_project_id or (apply and confirmed_project_id != expected_project_id):
        raise InputValidationError("Target project confirmation failed; no data operations started.")
    result = RemoteResult(
        mode="apply" if apply else "check_remote", project_id=expected_project_id,
        total=len(records), pending=len(records),
    )
    missing = []
    for record in records:
        try:
            reference = client.collection("data").document(record.date)
            snapshot = reference.get()
        except Exception:
            result.failed += 1
            result.pending -= 1
            result.failed_dates.append(record.date)
            result.status = "failed"
            return result
        if not snapshot.exists:
            missing.append((reference, record))
        elif _identical(snapshot, record):
            result.existing_identical += 1
            result.pending -= 1
        else:
            result.conflicts += 1
            result.pending -= 1
            result.conflict_dates.append(record.date)
    if result.conflicts:
        result.status = "conflict"
        return result
    if not apply:
        return result

    from google.api_core.exceptions import AlreadyExists

    for reference, record in missing:
        try:
            reference.create(record.model_dump())
            result.created += 1
        except AlreadyExists:
            # Another writer may have created the date since preflight.
            try:
                snapshot = reference.get()
                if _identical(snapshot, record):
                    result.existing_identical += 1
                else:
                    result.conflicts += 1
                    result.conflict_dates.append(record.date)
                    result.status = "conflict"
            except Exception:
                result.failed += 1
                result.failed_dates.append(record.date)
                result.status = "failed"
        except Exception:
            # A timeout may occur AFTER commit. Do not guess or overwrite/retry.
            result.failed += 1
            result.failed_dates.append(record.date)
            result.status = "failed"
        result.pending -= 1
        if result.status in ("failed", "conflict"):
            return result
    result.status = "complete"
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check-remote", action="store_true", help="Read-only inspection of all target dates")
    modes.add_argument("--apply", action="store_true", help="Create missing dates after confirmation and full preflight")
    parser.add_argument("--project-id", help="Expected actual Firebase project ID for remote modes")
    parser.add_argument("--confirm-project-id", help="Repeat the expected project ID to approve --apply")
    args = parser.parse_args(argv)
    try:
        records, validation = validate_csv()
        remote = args.check_remote or args.apply
        if not remote:
            if args.project_id or args.confirm_project_id:
                raise InputValidationError("Project options require --check-remote or --apply; no remote operations started.")
            print(json.dumps({
                "mode": "local", "collection": "data", "validation": validation,
                "planned_records": len(records), "document_id": "date", "remote_reads": 0,
                "remote_writes": 0, "status": "validated",
            }, ensure_ascii=False, indent=2))
            return 0
        if not args.project_id or (args.apply and args.confirm_project_id != args.project_id):
            raise InputValidationError("Remote modes require --project-id; --apply also requires matching --confirm-project-id.")
        if args.check_remote and args.confirm_project_id:
            raise InputValidationError("--confirm-project-id is only valid with --apply.")
        client = connect_target(args.project_id)
        result = inspect_or_import(
            records, client, args.project_id, apply=args.apply, confirmed_project_id=args.confirm_project_id,
        )
        print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
        return 1 if result.failed or result.conflicts else 0
    except InputValidationError as exc:
        print(json.dumps({"status": "blocked", "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception:
        print('{"status":"failed","message":"Import stopped; internal error details are suppressed."}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
