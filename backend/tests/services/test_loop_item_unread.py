# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy import func, select
from sqlalchemy.dialects import mysql

from app.services.loop_item_unread import _mysql_read_revision_expression


def test_mysql_read_revision_is_cast_to_numeric_json_value() -> None:
    metadata = func.json_object("content_revision", 2)
    revision = _mysql_read_revision_expression(metadata, "$.content_revision")
    statement = select(
        func.json_set(func.json_object(), '$.read_revisions."86"', revision)
    )

    compiled = str(statement.compile(dialect=mysql.dialect()))

    assert "json_unquote(json_extract(" in compiled
    assert " AS SIGNED INTEGER)" in compiled
