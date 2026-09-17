# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.utils.semver import parse_semver


def test_semver_precedence_matches_spec_example() -> None:
    versions = [
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-alpha.beta",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0-rc.1",
        "1.0.0",
    ]

    precedences = [parse_semver(version) for version in versions]

    assert precedences == sorted(precedences)


def test_semver_build_metadata_does_not_change_precedence() -> None:
    assert parse_semver("1.0.0+build.1") == parse_semver("1.0.0+build.2")


@pytest.mark.parametrize(
    "version",
    [
        "1.0",
        "01.0.0",
        "1.0.0-01",
        "v1.0.0",
    ],
)
def test_semver_rejects_invalid_versions(version: str) -> None:
    with pytest.raises(ValueError):
        parse_semver(version)
