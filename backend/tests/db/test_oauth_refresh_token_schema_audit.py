# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy import UniqueConstraint
from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateTable

from app.models.oauth_refresh_token import OAuthRefreshToken


def test_oauth_refresh_token_table_follows_database_audit_rules() -> None:
    table = OAuthRefreshToken.__table__

    assert table.comment
    assert not table.foreign_keys
    for column in table.columns:
        assert column.comment, f"{table.name}.{column.name} requires COMMENT"
        if column.primary_key and column.autoincrement:
            continue
        assert column.nullable is False
        assert (
            column.server_default is not None
        ), f"{table.name}.{column.name} requires an explicit DEFAULT"


def test_oauth_refresh_token_index_names_follow_database_audit_rules() -> None:
    table = OAuthRefreshToken.__table__

    for constraint in table.constraints:
        if isinstance(constraint, UniqueConstraint):
            assert constraint.name is not None
            assert constraint.name.startswith("uniq_")
    for index in table.indexes:
        assert index.name.startswith("uniq_" if index.unique else "idx_")


def test_oauth_refresh_token_mysql_ddl_uses_sentinels_and_utf8mb4() -> None:
    ddl = str(CreateTable(OAuthRefreshToken.__table__).compile(dialect=mysql.dialect()))

    assert "DEFAULT '1970-01-01 00:00:00'" in ddl
    assert "CHARSET=utf8mb4" in ddl
    assert "ENGINE=InnoDB" in ddl
    assert "FOREIGN KEY" not in ddl
