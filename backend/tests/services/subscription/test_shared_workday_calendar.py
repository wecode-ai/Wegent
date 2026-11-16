# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The offline resource preserves upstream data and wheel package inclusion."""

import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from importlib.resources import files
from pathlib import Path
from zipfile import ZipFile

import chinese_calendar
import pytest

from shared.utils.workday import WorkdayCalendarError, is_china_workday


def test_all_bundled_dates_match_authoritative_source():
    resource = files("shared").joinpath("assets/calendars/china-workdays.json")
    data = json.loads(resource.read_text(encoding="utf-8"))
    assert data["sourceVersion"] == chinese_calendar.__version__
    assert data["sourceUrl"] == "https://github.com/LKI/chinese-calendar"
    assert data["license"] == "MIT"
    assert data["holidays"] == sorted(d.isoformat() for d in chinese_calendar.holidays)
    assert data["workdays"] == sorted(d.isoformat() for d in chinese_calendar.workdays)
    day = datetime.fromisoformat(data["startDate"]).replace(tzinfo=timezone.utc)
    end = datetime.fromisoformat(data["endDate"]).replace(tzinfo=timezone.utc)
    while day <= end:
        assert is_china_workday(day) == chinese_calendar.is_workday(day.date())
        day += timedelta(days=1)
    with pytest.raises(WorkdayCalendarError):
        is_china_workday(day)
    with pytest.raises(WorkdayCalendarError):
        is_china_workday(datetime.fromisoformat(data["startDate"]) - timedelta(days=1))


def test_naive_utc_and_aware_instants_use_china_date():
    assert not is_china_workday(datetime(2026, 9, 30, 17))
    assert is_china_workday(datetime(2026, 10, 9, 17, tzinfo=timezone.utc))


def test_calendar_and_license_are_packaged_with_shared(tmp_path):
    shared_root = Path(__file__).resolve().parents[4] / "shared"
    subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(tmp_path), str(shared_root)],
        check=True,
        capture_output=True,
        text=True,
    )
    wheel = next(tmp_path.glob("*.whl"))
    with ZipFile(wheel) as archive:
        for filename in ["china-workdays.json", "LICENSE.chinesecalendar"]:
            resource = f"assets/calendars/{filename}"
            assert (
                archive.read(f"shared/{resource}")
                == (shared_root / resource).read_bytes()
            )
    subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            "import sys; sys.path.insert(0, sys.argv[1]); "
            "from datetime import datetime; "
            "from shared.utils.workday import is_china_workday; "
            "assert is_china_workday(datetime(2026, 10, 10, 1)); "
            "assert not is_china_workday(datetime(2026, 10, 1, 1))",
            str(wheel),
        ],
        check=True,
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )
