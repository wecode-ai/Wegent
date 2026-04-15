# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

from knowledge_engine.splitter.config import (
    MarkdownEnhancementConfig,
    NormalizedSplitterConfig,
)
from knowledge_engine.splitter.factory import create_splitter
from knowledge_engine.splitter.splitter import SentenceSplitter


def test_create_splitter_uses_default_hierarchical_config_when_missing() -> None:
    config = NormalizedSplitterConfig.model_construct(
        chunk_strategy="hierarchical",
        format_enhancement="none",
        flat_config=None,
        hierarchical_config=None,
        semantic_config=None,
        markdown_enhancement=MarkdownEnhancementConfig(),
        legacy_type=None,
    )

    splitter = create_splitter(config, embed_model=MagicMock())

    assert isinstance(splitter, SentenceSplitter)
    assert splitter.chunk_size == 512
    assert splitter.chunk_overlap == 64
    assert splitter.separator == "\n"
    assert splitter.paragraph_separator == "\n"
