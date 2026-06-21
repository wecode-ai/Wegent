# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from configparser import ConfigParser
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib


def test_default_pytest_addopts_do_not_enable_coverage():
    config = ConfigParser()
    config.read(Path(__file__).parents[2] / "pytest.ini")

    addopts = config.get("pytest", "addopts", fallback="")

    assert "--cov" not in addopts


def test_default_pytest_collection_excludes_manual_tests():
    config = ConfigParser()
    config.read(Path(__file__).parents[2] / "pytest.ini")

    ignored_dirs = config.get("pytest", "norecursedirs", fallback="")

    assert "tests/manual" in ignored_dirs.split()


def test_pytest_configuration_has_single_source():
    pyproject_path = Path(__file__).parents[2] / "pyproject.toml"
    pyproject = tomllib.loads(pyproject_path.read_text())

    assert "pytest" not in pyproject.get("tool", {})
