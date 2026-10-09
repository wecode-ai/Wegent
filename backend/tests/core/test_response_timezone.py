# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP responses must carry the +08:00 offset for naive datetimes."""

from datetime import datetime, timezone
from decimal import Decimal

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.core.response_timezone import patch_response_timezone


class _Doc(BaseModel):
    name: str
    created_at: datetime


class _Priced(BaseModel):
    amount: Decimal
    created_at: datetime


def _make_client() -> TestClient:
    patch_response_timezone()
    app = FastAPI()

    @app.get("/naive")
    def naive():
        return {"ts": datetime(2026, 10, 9, 15, 7, 46)}

    @app.get("/nested")
    def nested():
        return {"items": [{"created_at": datetime(2026, 10, 9, 7, 7, 51)}]}

    @app.get("/aware")
    def aware():
        return {"ts": datetime(2026, 10, 9, 7, 0, 0, tzinfo=timezone.utc)}

    @app.get("/model", response_model=_Doc)
    def model():
        return _Doc(name="x", created_at=datetime(2026, 10, 9, 15, 7, 46))

    @app.get("/priced", response_model=_Priced)
    def priced():
        return _Priced(
            amount=Decimal("19.99"), created_at=datetime(2026, 10, 9, 15, 7, 46)
        )

    return TestClient(app)


def test_naive_datetime_carries_session_offset():
    body = _make_client().get("/naive").json()
    assert body["ts"] == "2026-10-09T15:07:46+08:00"


def test_nested_naive_datetime_carries_session_offset():
    body = _make_client().get("/nested").json()
    assert body["items"][0]["created_at"] == "2026-10-09T07:07:51+08:00"


def test_aware_datetime_is_left_untouched():
    body = _make_client().get("/aware").json()
    assert body["ts"] == "2026-10-09T07:00:00Z"


def test_response_model_datetime_carries_session_offset():
    body = _make_client().get("/model").json()
    assert body["created_at"] == "2026-10-09T15:07:46+08:00"


def test_response_model_decimal_keeps_pydantic_json_format():
    body = _make_client().get("/priced").json()
    # pydantic JSON mode renders Decimal as a string to preserve precision.
    assert body["amount"] == "19.99"
    assert body["created_at"] == "2026-10-09T15:07:46+08:00"


def test_suffix_matches_database_dialect():
    from app.core.config import settings
    from app.core.response_timezone import _resolve_suffix

    original = settings.DATABASE_URL
    try:
        settings.DATABASE_URL = "sqlite:///test.db"
        assert _resolve_suffix() == "+00:00"
        settings.DATABASE_URL = "mysql+pymysql://u:p@localhost/db"
        assert _resolve_suffix() == "+08:00"
    finally:
        settings.DATABASE_URL = original
