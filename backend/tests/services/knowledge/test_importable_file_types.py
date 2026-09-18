# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for provider-neutral importable file classification."""

import pytest

from app.services.knowledge.importable_file_types import classify_importable_file
from app.services.wiki.connectors.gitlab_repo import GITLAB_REPO_IMPORT_EXTENSIONS


@pytest.mark.parametrize(
    "extension",
    [
        "pdf",
        "doc",
        "docx",
        "ppt",
        "pptx",
        "xls",
        "xlsx",
        "csv",
        "txt",
        "md",
        "markdown",
    ],
)
def test_gitlab_repo_accepts_configured_extensions(extension: str) -> None:
    decision = classify_importable_file(
        f"guide.{extension.upper()}",
        allowed_extensions=GITLAB_REPO_IMPORT_EXTENSIONS,
    )

    assert decision.importable is True
    assert decision.normalized_extension == extension


@pytest.mark.parametrize(
    ("filename", "reason"),
    [
        ("README", "missing_file_extension"),
        ("archive.zip", "unsupported_file_type"),
        ("", "invalid_file_name"),
    ],
)
def test_gitlab_repo_rejects_unsupported_names(filename: str, reason: str) -> None:
    decision = classify_importable_file(
        filename,
        allowed_extensions=GITLAB_REPO_IMPORT_EXTENSIONS,
    )

    assert decision.importable is False
    assert decision.reason == reason
