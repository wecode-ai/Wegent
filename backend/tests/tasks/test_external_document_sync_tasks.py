# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from app.services.knowledge.external_document_sync import (
    ConnectionSyncReport,
    SyncReport,
)
from app.tasks.external_document_sync_tasks import _log_sync_report


def test_logs_global_and_per_connection_sync_summaries(caplog) -> None:
    connection = ConnectionSyncReport(
        provider_id="wiki",
        owner_user_id=7,
        connection_id="conn-primary",
        connection_name="Primary Wiki",
        scanned=12,
        eligible=11,
        updates_detected=4,
        refresh_queued=3,
        reindex_queued=1,
        unchanged=5,
        source_missing=1,
        skipped=1,
        failed=0,
    )
    report = SyncReport(
        scanned=12,
        eligible=11,
        unchanged=5,
        refreshed=3,
        reindexed=1,
        skipped=1,
        failed=0,
        updates_detected=4,
        source_missing=1,
        connection_summaries={"wiki:7:conn-primary": connection},
    )

    with caplog.at_level(logging.INFO):
        _log_sync_report(report, elapsed_seconds=1.2345)

    assert "connection_name='Primary Wiki'" in caplog.text
    assert "scanned=12" in caplog.text
    assert "updates_detected=4" in caplog.text
    assert "refresh_queued=3" in caplog.text
    assert "reindex_queued=1" in caplog.text
    assert "source_missing=1" in caplog.text
    assert "failed=0" in caplog.text
    assert "[External Sync] total" in caplog.text
    assert "elapsed_seconds=1.234" in caplog.text
