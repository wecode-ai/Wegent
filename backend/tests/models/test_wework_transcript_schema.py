# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy import JSON, Text

from app.models.wework_transcript import (
    WeworkTranscript,
    WeworkTranscriptArchive,
    WeworkTranscriptTurn,
)


def test_wework_transcript_tables_follow_database_audit_contract():
    tables = (
        WeworkTranscript.__table__,
        WeworkTranscriptTurn.__table__,
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
            if isinstance(column.type, (JSON, Text)):
                continue
            assert column.server_default is not None


def test_wework_transcript_child_tables_use_logical_references():
    assert not WeworkTranscriptTurn.__table__.foreign_keys
    assert not WeworkTranscriptArchive.__table__.foreign_keys
