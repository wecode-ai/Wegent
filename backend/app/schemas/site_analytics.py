"""Strict, environment-independent site visit reporting contract."""

from datetime import date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SiteAnalyticsQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")

    @model_validator(mode="after")
    def validate_range(self) -> "SiteAnalyticsQuery":
        start, end = date.fromisoformat(self.start_date), date.fromisoformat(
            self.end_date
        )
        today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        if not 0 <= (end - start).days < 31 or end > today:
            raise ValueError("Date range must contain 1 to 31 days and no future dates")
        return self


class SiteAnalyticsCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pv: int = Field(strict=True, ge=0, le=9007199254740991)
    uv: int = Field(strict=True, ge=0, le=9007199254740991)

    @model_validator(mode="after")
    def validate_counts(self) -> "SiteAnalyticsCounts":
        if self.uv > self.pv:
            raise ValueError("UV must not exceed PV")
        return self


class SiteAnalyticsDay(SiteAnalyticsCounts):
    date: date


class SiteAnalyticsResponse(SiteAnalyticsQuery):
    project_id: str
    timezone: Literal["Asia/Shanghai"]
    totals: SiteAnalyticsCounts
    daily: list[SiteAnalyticsDay] = Field(min_length=1, max_length=31)
    queried_at: datetime

    @model_validator(mode="after")
    def validate_daily(self) -> "SiteAnalyticsResponse":
        start, end = date.fromisoformat(self.start_date), date.fromisoformat(
            self.end_date
        )
        expected = [start + timedelta(days=i) for i in range((end - start).days + 1)]
        if [item.date for item in self.daily] != expected:
            raise ValueError("Daily results must cover the full date range in order")
        if sum(item.pv for item in self.daily) != self.totals.pv:
            raise ValueError("Daily PV does not match total PV")
        if (
            not max(item.uv for item in self.daily)
            <= self.totals.uv
            <= sum(item.uv for item in self.daily)
        ):
            raise ValueError("Invalid total UV")
        if self.queried_at.tzinfo is None:
            raise ValueError("queried_at must include a timezone")
        return self
