# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for InstalledPluginPackage storage column types."""

import pytest
from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateTable

from app.models.installed_plugin_package import InstalledPluginPackage

pytestmark = pytest.mark.unit


def test_installed_plugin_package_uses_mediumblob_on_mysql() -> None:
    statement = str(
        CreateTable(InstalledPluginPackage.__table__).compile(dialect=mysql.dialect())
    )

    assert "binary_data MEDIUMBLOB NOT NULL" in statement
