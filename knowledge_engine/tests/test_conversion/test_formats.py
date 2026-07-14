# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for knowledge-base format capabilities."""

from knowledge_engine.conversion.formats import (
    KnowledgeFormatPipeline,
    get_knowledge_format,
    get_knowledge_pipeline,
    is_supported_knowledge_format,
    list_knowledge_formats,
    validate_knowledge_file,
)


def test_registry_contains_ap_supported_formats():
    expected = {
        "pdf",
        "docx",
        "doc",
        "pptx",
        "ppt",
        "xlsx",
        "xls",
        "epub",
        "eml",
        "md",
        "markdown",
        "txt",
        "csv",
        "html",
        "htm",
        "jpg",
        "jpeg",
        "png",
        "gif",
        "webp",
        "bmp",
        "mp4",
        "avi",
        "mov",
        "mkv",
        "webm",
        "flv",
        "wmv",
        "m4v",
        "py",
        "js",
        "ts",
        "vue",
        "css",
        "java",
        "go",
        "rs",
        "cpp",
        "c",
        "swift",
        "kt",
        "kts",
        "rb",
        "php",
        "sql",
        "sh",
        "yaml",
        "yml",
        "json",
        "xml",
        "ini",
        "toml",
        "lock",
    }
    actual = {fmt.extension for fmt in list_knowledge_formats()}

    assert expected <= actual


def test_iwork_formats_are_known_but_not_enabled():
    assert is_supported_knowledge_format("key") is False
    assert is_supported_knowledge_format("numbers") is False
    assert is_supported_knowledge_format("pages") is False

    key_format = get_knowledge_format("key", include_disabled=True)
    assert key_format is not None
    assert key_format.enabled is False


def test_unsupported_formats_are_not_registered_as_supported():
    assert is_supported_knowledge_format("msg") is False
    assert is_supported_knowledge_format("azw3") is False
    assert is_supported_knowledge_format("mobi") is False


def test_pipeline_classification():
    assert get_knowledge_pipeline("pdf") == KnowledgeFormatPipeline.MINERU
    assert get_knowledge_pipeline("epub") == KnowledgeFormatPipeline.LOCAL_MARKDOWN
    assert get_knowledge_pipeline("py") == KnowledgeFormatPipeline.DIRECT
    assert get_knowledge_pipeline("gif") == KnowledgeFormatPipeline.MULTIMODAL
    assert get_knowledge_pipeline("mp4") == KnowledgeFormatPipeline.MULTIMODAL


def test_text_validation_rejects_binary_lock_file():
    try:
        validate_knowledge_file(b"\x00\x01\x02", "lock")
    except ValueError as exc:
        assert "binary" in str(exc)
    else:
        raise AssertionError("Expected binary lock file to be rejected")
