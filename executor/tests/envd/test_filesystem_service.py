# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timezone

from executor.envd.service import filesystem_service
from executor.envd.service.filesystem_service import FilesystemServiceHandler


def test_get_entry_info_builds_modified_time_in_utc(monkeypatch, tmp_path):
    observed_timezone = {"value": None}
    real_datetime = datetime

    class DateTimeSpy:
        @classmethod
        def fromtimestamp(cls, timestamp, tz=None):
            observed_timezone["value"] = tz
            return real_datetime.fromtimestamp(timestamp, tz=tz)

    file_path = tmp_path / "utc-check.txt"
    file_path.write_text("content", encoding="utf-8")

    monkeypatch.setattr(filesystem_service, "datetime", DateTimeSpy)

    handler = FilesystemServiceHandler()
    entry = handler._get_entry_info(str(file_path))

    assert entry.name == "utc-check.txt"
    assert observed_timezone["value"] == timezone.utc
