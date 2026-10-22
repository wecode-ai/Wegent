# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the converter worker's adapter to the shared knowledge module."""

from unittest.mock import patch

from knowledge_doc_converter.services.conversion_engine import (
    MinerUContentConversionAdapter,
)
from knowledge_engine.conversion import MinerUConfig, S3Config
from shared.knowledge_module import ConversionEngineResult


def _adapter() -> MinerUContentConversionAdapter:
    return MinerUContentConversionAdapter(
        mineru_config=MinerUConfig(api_base_url="http://mineru:8888"),
        s3_config=S3Config(enabled=False),
    )


def test_supports_only_the_engine_formats() -> None:
    adapter = _adapter()

    assert adapter.supports_conversion("pdf") is True
    assert adapter.supports_conversion(".docx") is True
    assert adapter.supports_conversion("zip") is False


def test_converts_with_the_engine_and_maps_the_result_into_the_module_contract() -> (
    None
):
    engine_result = type(
        "EngineResult",
        (),
        {
            "markdown_bytes": b"# Converted\n",
            "uploaded_images": [("a.png", "http://s3/a.png")],
        },
    )()

    with patch(
        "knowledge_doc_converter.services.conversion_engine.convert_document",
        return_value=engine_result,
    ) as convert_document:
        converted = _adapter().convert(
            binary_data=b"%PDF-1.7",
            extension="pdf",
            storage_prefix="doc-converter/kb/1/report",
        )

    assert isinstance(converted, ConversionEngineResult)
    assert converted.markdown_bytes == b"# Converted\n"
    assert converted.uploaded_images == (("a.png", "http://s3/a.png"),)
    call_kwargs = convert_document.call_args.kwargs
    assert call_kwargs["binary_data"] == b"%PDF-1.7"
    assert call_kwargs["file_extension"] == "pdf"
    assert call_kwargs["s3_base_path"] == "doc-converter/kb/1/report"
    assert call_kwargs["mineru_config"].api_base_url == "http://mineru:8888"
