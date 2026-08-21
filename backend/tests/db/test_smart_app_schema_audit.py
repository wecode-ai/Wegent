# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy import Enum, String, UniqueConstraint
from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateTable

from app.models.smart_app_marketplace import (
    SmartApp,
    SmartAppRelease,
    SmartAppSubmission,
)

SMART_APP_TABLES = (
    SmartApp.__table__,
    SmartAppRelease.__table__,
    SmartAppSubmission.__table__,
)


def test_smart_app_columns_follow_database_audit_rules():
    for table in SMART_APP_TABLES:
        for column in table.columns:
            assert column.comment, f"{table.name}.{column.name} requires COMMENT"
            assert not isinstance(column.type, Enum)
            if column.primary_key and column.autoincrement:
                continue
            assert column.nullable is False
            assert (
                column.server_default is not None
            ), f"{table.name}.{column.name} requires an explicit DEFAULT"


def test_smart_app_index_names_follow_database_audit_rules():
    for table in SMART_APP_TABLES:
        for constraint in table.constraints:
            if isinstance(constraint, UniqueConstraint):
                assert constraint.name is not None
                assert constraint.name.startswith("uniq_")
        for index in table.indexes:
            assert index.name.startswith("uniq_" if index.unique else "idx_")


def test_smart_app_tables_do_not_define_database_foreign_keys():
    for table in SMART_APP_TABLES:
        assert not table.foreign_keys


def test_smart_app_varchar_rows_fit_utf8mb4_budget():
    for table in SMART_APP_TABLES:
        maximum_varchar_bytes = sum(
            column.type.length * 4
            for column in table.columns
            if isinstance(column.type, String) and column.type.length is not None
        )
        assert (
            maximum_varchar_bytes < 60_000
        ), f"{table.name} VARCHAR columns exceed the safe utf8mb4 row budget"


def test_smart_app_mysql_ddl_has_audited_defaults():
    ddl = "\n".join(
        str(CreateTable(table).compile(dialect=mysql.dialect()))
        for table in SMART_APP_TABLES
    )

    assert "description_md VARCHAR(8192)" in ddl
    assert "DEFAULT ('{}')" in ddl
    assert "DEFAULT ('[]')" in ddl
    assert "DEFAULT CURRENT_TIMESTAMP(6)" in ddl
    assert "ON UPDATE CURRENT_TIMESTAMP(6)" in ddl
    assert "DEFAULT '1970-01-01 00:00:00.000000'" in ddl
    assert "ENUM(" not in ddl
    assert "FOREIGN KEY" not in ddl
