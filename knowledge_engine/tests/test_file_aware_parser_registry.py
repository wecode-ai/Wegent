# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

from llama_index.core import Document

from knowledge_engine.splitter.file_aware import (
    resolve_file_aware_parser_subtype,
    supports_file_aware_split,
)
from knowledge_engine.splitter.smart import SmartSplitter


def test_resolve_file_aware_parser_subtype_maps_supported_extensions() -> None:
    assert resolve_file_aware_parser_subtype(".md") == "markdown_sentence"
    assert resolve_file_aware_parser_subtype(".txt") == "sentence"
    assert resolve_file_aware_parser_subtype(".pdf") == "recursive_character"
    assert resolve_file_aware_parser_subtype(".DOCX") == "recursive_character"


def test_supports_file_aware_split_limits_legacy_file_extensions() -> None:
    assert supports_file_aware_split(".md") is True
    assert supports_file_aware_split(".txt") is True
    assert supports_file_aware_split(".json") is False


def test_smart_splitter_uses_registry_for_subtype_resolution() -> None:
    splitter = SmartSplitter(".Md")

    assert splitter._get_subtype() == "markdown_sentence"
    assert SmartSplitter.supports_smart_split(".DOCX") is True


def test_smart_splitter_routes_documents_through_registry_subtype() -> None:
    documents = [Document(text="example text")]

    with (
        patch.object(
            SmartSplitter,
            "_split_markdown",
            return_value=["markdown"],
        ) as split_markdown,
        patch.object(
            SmartSplitter,
            "_split_text",
            return_value=["sentence"],
        ) as split_text,
        patch.object(
            SmartSplitter,
            "_split_recursive",
            return_value=["recursive"],
        ) as split_recursive,
    ):
        assert SmartSplitter(".md").split_documents(documents) == ["markdown"]
        assert SmartSplitter(".txt").split_documents(documents) == ["sentence"]
        assert SmartSplitter(".pdf").split_documents(documents) == ["recursive"]

    assert split_markdown.call_count == 1
    assert split_text.call_count == 1
    assert split_recursive.call_count == 1
