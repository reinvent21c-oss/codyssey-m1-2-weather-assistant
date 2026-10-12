"""Request/response validation shared by the API and stored documents."""

from datetime import date as calendar_date
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, FiniteFloat, StrictStr, field_validator


def validate_date(value: str) -> str:
    calendar_date.fromisoformat(value)
    return value


DateString = Annotated[
    str, Field(strict=True, pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"), AfterValidator(validate_date)
]


class DataRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: DateString
    value: FiniteFloat
    memo: StrictStr

    @field_validator("value", mode="before")
    @classmethod
    def require_number(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("value must be a finite JSON number")
        return value


class DeleteResult(BaseModel):
    id: DateString
    deleted: bool


class TemperatureTrend(BaseModel):
    status: Literal["rising", "falling", "stable", "insufficient_data"]
    threshold_celsius: float = 0.5
    latest_week_mean: float | None = None
    previous_week_mean: float | None = None


class DataSummary(BaseModel):
    start_date: DateString | None
    end_date: DateString | None
    count: int
    mean_value: float | None
    max_value: float | None
    min_value: float | None
    trend: TemperatureTrend
