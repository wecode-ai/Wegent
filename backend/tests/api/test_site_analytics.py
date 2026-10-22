from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from pytest_httpx import HTTPXMock

from app.core.config import settings

PROJECT = "prj_01k0a0bcdefghjkmnpqrstvwxy"
BASE = "https://sites.example.test"
URL = f"/api/sites/{PROJECT}/analytics"
PARAMS = "start_date=2026-10-01&end_date=2026-10-03"


def analytics():
    return {
        "project_id": PROJECT,
        "timezone": "Asia/Shanghai",
        "start_date": "2026-10-01",
        "end_date": "2026-10-03",
        "totals": {"pv": 5, "uv": 2},
        "daily": [
            {"date": "2026-10-01", "pv": 2, "uv": 2},
            {"date": "2026-10-02", "pv": 0, "uv": 0},
            {"date": "2026-10-03", "pv": 3, "uv": 2},
        ],
        "queried_at": "2026-10-03T08:00:00Z",
    }


@pytest.fixture(autouse=True)
def configure(monkeypatch):
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", BASE)
    monkeypatch.setattr(settings, "SITES_API_TOKEN", "test-platform-token")


def test_requires_authentication(test_client: TestClient):
    assert test_client.get(f"{URL}?{PARAMS}").status_code == 401


def test_forwards_only_dates_and_trusted_identity(
    test_client, test_token, httpx_mock: HTTPXMock
):
    httpx_mock.add_response(
        url=f"{BASE}/api/v1/projects/{PROJECT}/analytics?{PARAMS}", json=analytics()
    )
    response = test_client.get(
        f"{URL}?{PARAMS}",
        headers={
            "Authorization": f"Bearer {test_token}",
            "X-Wegent-Username": "spoofed",
        },
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == analytics()
    upstream = httpx_mock.get_requests()[0]
    assert upstream.headers["x-wegent-username"] == "testuser"
    assert upstream.headers["authorization"] == "Bearer test-platform-token"
    assert "environment" not in response.json()


@pytest.mark.parametrize(
    "params",
    [
        "start_date=2026-10-01&end_date=2026-11-01",
        "start_date=2026-02-29&end_date=2026-03-01",
        "start_date=2026-10-03&end_date=2026-10-01",
        "start_date=9999-01-01&end_date=9999-01-01",
        "start_date=2026-1-1&end_date=2026-01-01",
        PARAMS + "&environment=production",
        PARAMS + "&username=owner",
        PARAMS + "&start_date=2026-10-02",
    ],
)
def test_rejects_invalid_query_without_upstream(
    test_client, test_token, httpx_mock, params
):
    assert (
        test_client.get(
            f"{URL}?{params}", headers={"Authorization": f"Bearer {test_token}"}
        ).status_code
        == 400
    )
    assert not httpx_mock.get_requests()


@pytest.mark.parametrize("days", [1, 31])
def test_inclusive_range_boundaries(test_client, test_token, httpx_mock, days):
    start = date(2026, 8, 1)
    end = start + timedelta(days=days - 1)
    payload = analytics()
    payload.update(
        start_date=start.isoformat(),
        end_date=end.isoformat(),
        totals={"pv": 0, "uv": 0},
        daily=[
            {"date": (start + timedelta(days=i)).isoformat(), "pv": 0, "uv": 0}
            for i in range(days)
        ],
    )
    httpx_mock.add_response(json=payload)
    result = test_client.get(
        URL,
        params={"start_date": start.isoformat(), "end_date": end.isoformat()},
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert result.status_code == 200
    assert len(result.json()["daily"]) == days


@pytest.mark.parametrize(
    "status,code",
    [
        (404, "NOT_FOUND"),
        (429, "ANALYTICS_RATE_LIMITED"),
        (503, "ANALYTICS_NOT_CONFIGURED"),
        (504, "ANALYTICS_TIMEOUT"),
    ],
)
def test_preserves_upstream_errors(test_client, test_token, httpx_mock, status, code):
    httpx_mock.add_response(
        status_code=status, json={"error": {"code": code, "message": "Unavailable"}}
    )
    result = test_client.get(
        f"{URL}?{PARAMS}", headers={"Authorization": f"Bearer {test_token}"}
    )
    assert result.status_code == status
    assert result.json()["detail"]["code"] == code


@pytest.mark.parametrize(
    "mutation",
    [
        {"environment": "production"},
        {"project_id": "other"},
        {"daily": []},
        {"totals": {"pv": 5, "uv": 5}},
        {"totals": {"pv": "5", "uv": 2}},
        {"queried_at": "2026-10-03T08:00:00"},
    ],
)
def test_rejects_upstream_contract_drift(test_client, test_token, httpx_mock, mutation):
    httpx_mock.add_response(json={**analytics(), **mutation})
    result = test_client.get(
        f"{URL}?{PARAMS}", headers={"Authorization": f"Bearer {test_token}"}
    )
    assert result.status_code == 502
