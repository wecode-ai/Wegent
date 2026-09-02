# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Hard archive boundaries for uploaded Skill packages."""

import io
import zipfile

import pytest
from fastapi import HTTPException

from app.services.skill_service import SkillValidator


def _archive(entries: list[tuple[str, bytes | str]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename, content in entries:
            archive.writestr(filename, content)
    return buffer.getvalue()


def test_uncompressed_total_accepts_exact_limit_and_rejects_one_more(
    monkeypatch,
) -> None:
    skill_markdown = "---\ndescription: bounded\n---\n"
    exact_total = len(skill_markdown.encode()) + 4
    monkeypatch.setattr(
        SkillValidator,
        "MAX_UNCOMPRESSED_SIZE",
        exact_total,
    )
    exact_archive = _archive(
        [
            ("bounded/SKILL.md", skill_markdown),
            ("bounded/data.bin", b"1234"),
        ]
    )
    oversized_archive = _archive(
        [
            ("bounded/SKILL.md", skill_markdown),
            ("bounded/data.bin", b"12345"),
        ]
    )

    assert (
        SkillValidator.validate_zip(exact_archive, "bounded.zip")["description"]
        == "bounded"
    )
    with pytest.raises(HTTPException) as exc_info:
        SkillValidator.validate_zip(oversized_archive, "bounded.zip")

    assert exc_info.value.status_code == 413
    assert "Uncompressed Skill package" in exc_info.value.detail


def test_archive_entry_count_accepts_exact_limit_and_rejects_one_more(
    monkeypatch,
) -> None:
    skill_markdown = "---\ndescription: bounded\n---\n"
    monkeypatch.setattr(SkillValidator, "MAX_ARCHIVE_ENTRIES", 2)
    exact_archive = _archive(
        [
            ("bounded/SKILL.md", skill_markdown),
            ("bounded/one.txt", b"1"),
        ]
    )
    oversized_archive = _archive(
        [
            ("bounded/SKILL.md", skill_markdown),
            ("bounded/one.txt", b"1"),
            ("bounded/two.txt", b"2"),
        ]
    )

    assert SkillValidator.validate_zip(exact_archive, "bounded.zip")
    with pytest.raises(HTTPException) as exc_info:
        SkillValidator.validate_zip(oversized_archive, "bounded.zip")

    assert exc_info.value.status_code == 400
    assert "too many entries" in exc_info.value.detail


def test_skill_markdown_accepts_exact_limit_and_rejects_one_more(
    monkeypatch,
) -> None:
    exact_markdown = "---\ndescription: x\n---\n"
    monkeypatch.setattr(
        SkillValidator,
        "MAX_SKILL_MD_SIZE",
        len(exact_markdown.encode()),
    )
    exact_archive = _archive([("bounded/SKILL.md", exact_markdown)])
    oversized_archive = _archive([("bounded/SKILL.md", exact_markdown + "x")])

    assert SkillValidator.validate_zip(exact_archive, "bounded.zip")
    with pytest.raises(HTTPException) as exc_info:
        SkillValidator.validate_zip(oversized_archive, "bounded.zip")

    assert exc_info.value.status_code == 413
    assert "SKILL.md is too large" in exc_info.value.detail


def test_frontmatter_accepts_exact_limit_and_rejects_one_more(monkeypatch) -> None:
    exact_frontmatter = "description: x"
    monkeypatch.setattr(
        SkillValidator,
        "MAX_FRONTMATTER_SIZE",
        len(exact_frontmatter),
    )

    assert SkillValidator._parse_skill_md(f"---\n{exact_frontmatter}\n---\n") == {
        "description": "x"
    }
    with pytest.raises(HTTPException) as exc_info:
        SkillValidator._parse_skill_md("---\ndescription: xx\n---\n")

    assert exc_info.value.status_code == 413
    assert "frontmatter is too large" in exc_info.value.detail
