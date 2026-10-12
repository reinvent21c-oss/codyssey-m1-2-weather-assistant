"""Firestore CRUD and summaries; no Firebase connection occurs on import."""

from datetime import date, timedelta
from decimal import Decimal, localcontext

from firebase_admin import firestore
from google.api_core.exceptions import AlreadyExists, NotFound

from backend.schemas import DataRecord, DataSummary, TemperatureTrend


class DuplicateData(Exception):
    pass


class DataNotFound(Exception):
    pass


class StorageUnavailable(Exception):
    pass


def _mean(values):
    # Decimal avoids overflow when summing otherwise finite floating-point values.
    with localcontext() as context:
        context.prec = 700  # Covers the entire finite IEEE-754 float range.
        return sum((Decimal(str(value)) for value in values), Decimal(0)) / len(values)


class DataService:
    def __init__(self, client):
        self.client = client

    def create(self, record: DataRecord) -> DataRecord:
        try:
            # create() is atomic: concurrent POSTs cannot overwrite this date.
            self.client.collection("data").document(record.date).create(record.model_dump())
        except AlreadyExists:
            raise DuplicateData() from None
        except Exception:
            raise StorageUnavailable() from None
        return record

    def list_records(self) -> list[DataRecord]:
        try:
            records = []
            for snapshot in self.client.collection("data").stream():
                record = DataRecord.model_validate(snapshot.to_dict())
                if record.date != snapshot.id:
                    raise ValueError("Stored document ID/date mismatch")
                records.append(record)
            return sorted(records, key=lambda record: record.date)
        except Exception:
            raise StorageUnavailable() from None

    def update(self, document_id: str, record: DataRecord) -> DataRecord:
        try:
            # update() has an existence precondition; it never creates a missing ID.
            self.client.collection("data").document(document_id).update(record.model_dump())
        except NotFound:
            raise DataNotFound() from None
        except Exception:
            raise StorageUnavailable() from None
        return record

    def delete(self, document_id: str):
        try:
            reference = self.client.collection("data").document(document_id)

            @firestore.transactional
            def delete_existing(transaction):
                if not reference.get(transaction=transaction).exists:
                    raise DataNotFound()
                transaction.delete(reference)

            # Keep the existence check and deletion in one atomic transaction.
            delete_existing(self.client.transaction())
        except DataNotFound:
            raise
        except NotFound:
            raise DataNotFound() from None
        except Exception:
            raise StorageUnavailable() from None

    def summary(self) -> DataSummary:
        records = self.list_records()
        trend = TemperatureTrend(status="insufficient_data")
        if not records:
            return DataSummary(
                start_date=None, end_date=None, count=0,
                mean_value=None, max_value=None, min_value=None, trend=trend,
            )

        by_date = {record.date: record.value for record in records}
        end = date.fromisoformat(records[-1].date)
        days = [(end - timedelta(days=offset)).isoformat() for offset in range(min(14, end.toordinal()))]
        # Require all calendar dates in both seven-day windows, not just 14 rows.
        if len(days) == 14 and all(day in by_date for day in days):
            latest = _mean([by_date[day] for day in days[:7]])
            previous = _mean([by_date[day] for day in days[7:]])
            difference = latest - previous
            threshold = Decimal(str(trend.threshold_celsius))
            status = "rising" if difference >= threshold else "falling" if difference <= -threshold else "stable"
            trend = TemperatureTrend(
                status=status, latest_week_mean=float(latest), previous_week_mean=float(previous),
            )
        values = [record.value for record in records]
        return DataSummary(
            start_date=records[0].date, end_date=records[-1].date, count=len(records),
            mean_value=float(_mean(values)), max_value=max(values), min_value=min(values), trend=trend,
        )
