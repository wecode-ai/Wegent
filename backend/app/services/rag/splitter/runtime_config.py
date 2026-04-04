# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime helpers for parsing transport-safe splitter configs."""

import logging
from typing import Optional

from app.schemas.rag import (
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SmartSplitterConfig,
    SplitterConfig,
)

logger = logging.getLogger(__name__)


def parse_runtime_splitter_config(config_dict: dict | None) -> Optional[SplitterConfig]:
    """Parse a plain dict into the appropriate runtime splitter config model."""
    if not config_dict:
        return None

    splitter_type = config_dict.get("type")
    if splitter_type == "semantic":
        return SemanticSplitterConfig(**config_dict)
    if splitter_type == "smart":
        return SmartSplitterConfig(**config_dict)
    if splitter_type not in (None, "sentence"):
        logger.warning(
            "Unknown splitter type '%s', defaulting to sentence splitter",
            splitter_type,
        )
    return SentenceSplitterConfig(**config_dict)
