# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wegent adapter for the reusable knowledge module's content conversion.

The shared module owns the conversion request rules, the converted filename and
the object-key prefix. This adapter supplies what only this worker can supply:
the MinerU and S3 credentials it resolved from service settings, and the
knowledge_engine call that performs the conversion.
"""

from __future__ import annotations

from knowledge_engine.conversion import S3Config, convert_document
from knowledge_engine.conversion.mineru_client import (
    MinerUConfig,
    is_supported_extension,
)
from shared.knowledge_module import ConversionEngineResult


class MinerUContentConversionAdapter:
    """Convert one document with this worker's MinerU engine and credentials."""

    def __init__(
        self, *, mineru_config: MinerUConfig, s3_config: S3Config | None = None
    ) -> None:
        self._mineru_config = mineru_config
        self._s3_config = s3_config

    def supports_conversion(self, extension: str) -> bool:
        return is_supported_extension(extension)

    def convert(
        self, *, binary_data: bytes, extension: str, storage_prefix: str
    ) -> ConversionEngineResult:
        result = convert_document(
            binary_data=binary_data,
            file_extension=extension,
            mineru_config=self._mineru_config,
            s3_config=self._s3_config,
            s3_base_path=storage_prefix,
        )
        return ConversionEngineResult(
            markdown_bytes=result.markdown_bytes,
            uploaded_images=tuple(result.uploaded_images or ()),
        )
