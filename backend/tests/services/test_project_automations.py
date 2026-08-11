from datetime import datetime

import pytest
from fastapi import HTTPException

from app.services.project_automations import _next_run


def test_next_run_respects_rule_timezone():
    result = _next_run(
        "0 3 * * *",
        "Asia/Shanghai",
        datetime(2026, 8, 11, 0, 0),
    )

    assert result == datetime(2026, 8, 11, 19, 0)


@pytest.mark.parametrize("expression", ["", "not-a-cron", "0 3 *"])
def test_next_run_rejects_invalid_cron(expression: str):
    with pytest.raises(HTTPException) as exc_info:
        _next_run(expression, "UTC", datetime(2026, 8, 11, 0, 0))

    assert exc_info.value.status_code == 422


def test_next_run_rejects_unknown_timezone():
    with pytest.raises(HTTPException) as exc_info:
        _next_run("0 3 * * *", "Mars/Olympus", datetime(2026, 8, 11, 0, 0))

    assert exc_info.value.status_code == 422
