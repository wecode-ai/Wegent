# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared SemVer 2.0 validation and precedence (https://semver.org)."""

import re
from dataclasses import dataclass

_NUMERIC = r"(?:0|[1-9][0-9]*)"
_PRERELEASE_IDENTIFIER = rf"(?:{_NUMERIC}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
_SEMVER_PATTERN = re.compile(
    rf"(?P<major>{_NUMERIC})\.(?P<minor>{_NUMERIC})\.(?P<patch>{_NUMERIC})"
    rf"(?:-(?P<prerelease>{_PRERELEASE_IDENTIFIER}"
    rf"(?:\.{_PRERELEASE_IDENTIFIER})*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)


@dataclass(frozen=True, order=True)
class SemVerPrecedence:
    """Comparable precedence; build metadata intentionally does not participate."""

    # Length then ASCII digits compare numbers without an integer size limit.
    major: tuple[int, str]
    minor: tuple[int, str]
    patch: tuple[int, str]
    stable: bool
    prerelease: tuple[tuple[bool, int, str], ...]


def parse_semver(version: str) -> SemVerPrecedence:
    """Validate strict SemVer and return its precedence, or raise ValueError."""
    match = _SEMVER_PATTERN.fullmatch(version) if isinstance(version, str) else None
    if match is None:
        raise ValueError("Version must be SemVer 2.0")
    major, minor, patch = (match[group] for group in ("major", "minor", "patch"))
    prerelease = match["prerelease"]
    identifiers = () if prerelease is None else tuple(prerelease.split("."))
    return SemVerPrecedence(
        major=(len(major), major),
        minor=(len(minor), minor),
        patch=(len(patch), patch),
        stable=prerelease is None,
        prerelease=tuple(
            (
                (False, len(identifier), identifier)
                if identifier.isdigit()
                else (True, 0, identifier)
            )
            for identifier in identifiers
        ),
    )
