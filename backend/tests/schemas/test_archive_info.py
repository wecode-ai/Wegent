# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ArchiveInfo datetime serialization."""

from datetime import datetime, timedelta, timezone

from app.schemas.kind import ArchiveInfo


def test_archive_info_serializes_datetimes_to_configured_timezone():
    """Archive datetimes should be serialized in the configured display timezone."""
    archive_info = ArchiveInfo(
        storageKey="workspace-archives/1/archive.tar.gz",
        archivedAt=datetime(2026, 4, 2, 12, 50, 21, tzinfo=timezone.utc),
        expiresAt=datetime(2026, 5, 2, 12, 50, 21, tzinfo=timezone.utc),
    )

    payload = archive_info.model_dump(mode="json")
    archived_at = datetime.fromisoformat(payload["archivedAt"])
    expires_at = datetime.fromisoformat(payload["expiresAt"])

    assert archived_at.utcoffset() == timedelta(hours=8)
    assert expires_at.utcoffset() == timedelta(hours=8)
    assert archived_at.hour == 20
    assert expires_at.hour == 20
