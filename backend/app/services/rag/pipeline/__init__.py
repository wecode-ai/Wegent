# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document processing pipeline module.

This module provides a pipeline architecture for processing documents
through read -> convert -> split stages. Different pipeline implementations
support various document formats and conversion methods (LlamaIndex, Pandoc, Docling).
"""

from app.services.rag.pipeline.base import BaseDocumentPipeline
from app.services.rag.pipeline.docling import DoclingPipeline
from app.services.rag.pipeline.factory import create_pipeline, should_use_pipeline
from app.services.rag.pipeline.llamaindex import LlamaIndexPipeline
from app.services.rag.pipeline.pandoc import PandocPipeline

__all__ = [
    "BaseDocumentPipeline",
    "LlamaIndexPipeline",
    "PandocPipeline",
    "DoclingPipeline",
    "create_pipeline",
    "should_use_pipeline",
]
