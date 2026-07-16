# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.utils.mime_types import (
    TEXT_READABLE_MIME_TYPES,
    is_text_readable_mime,
)


def test_text_family_is_readable():
    assert is_text_readable_mime("text/plain")
    assert is_text_readable_mime("text/markdown")
    assert is_text_readable_mime("text/x-python")
    # Any text/* subtype, even one not enumerated, is readable by prefix.
    assert is_text_readable_mime("text/some-new-subtype")


def test_application_text_types_are_readable():
    assert is_text_readable_mime("application/json")
    assert is_text_readable_mime("application/xml")
    assert is_text_readable_mime("application/yaml")


def test_structured_suffixes_are_readable():
    assert is_text_readable_mime("application/ld+json")
    assert is_text_readable_mime("application/atom+xml")


def test_binary_documents_and_media_are_not_readable():
    assert not is_text_readable_mime("application/pdf")
    assert not is_text_readable_mime(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert not is_text_readable_mime("application/vnd.xmind.workbook")
    assert not is_text_readable_mime("image/png")
    assert not is_text_readable_mime("video/mp4")
    assert not is_text_readable_mime("application/octet-stream")


def test_empty_or_none_is_not_readable():
    assert not is_text_readable_mime("")
    assert not is_text_readable_mime(None)


def test_parameters_and_case_are_normalized():
    assert is_text_readable_mime("text/plain; charset=utf-8")
    assert is_text_readable_mime("Application/JSON")
    assert is_text_readable_mime("  text/csv  ")


def test_set_membership_is_usable_directly():
    # Callers that test the set directly still work (e.g. the parser alias).
    assert "text/plain" in TEXT_READABLE_MIME_TYPES
    assert "application/json" in TEXT_READABLE_MIME_TYPES
