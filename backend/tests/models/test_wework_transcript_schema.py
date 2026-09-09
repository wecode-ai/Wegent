# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.wework_transcript import (
    WeworkTranscript,
    WeworkTranscriptArchive,
)


def test_wework_transcript_tables_follow_database_audit_contract():
    tables = (
        WeworkTranscript.__table__,
        WeworkTranscriptArchive.__table__,
    )

    for table in tables:
        assert table.comment
        assert "collate" not in table.dialect_options["mysql"]
        for column in table.columns:
            assert column.comment
            if column.primary_key:
                continue
            assert not column.nullable
            assert column.server_default is not None


def test_wework_transcript_child_tables_use_logical_references():
    assert not WeworkTranscriptArchive.__table__.foreign_keys


def test_wework_transcript_indexes_use_standard_prefixes():
    tables = (
        WeworkTranscript.__table__,
        WeworkTranscriptArchive.__table__,
    )

    for table in tables:
        for index in table.indexes:
            assert index.name.startswith(("idx_", "uniq_"))
