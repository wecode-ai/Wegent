# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for SkillBinary storage column types."""

import pytest
from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateTable

from app.models.skill_binary import SkillBinary

pytestmark = pytest.mark.unit


def test_skill_binary_uses_mediumblob_on_mysql() -> None:
    statement = str(CreateTable(SkillBinary.__table__).compile(dialect=mysql.dialect()))

    assert "binary_data MEDIUMBLOB NOT NULL" in statement
    assert "type VARCHAR(32) NOT NULL" in statement
    assert "file_name VARCHAR(255) NOT NULL" in statement
