# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, ClassVar, Dict, List

from llama_index.core.schema import BaseNode

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from knowledge_engine.storage.chunk_metadata import ChunkMetadata


class BaseStorageBackend(ABC):
    SUPPORTED_RETRIEVAL_METHODS: ClassVar[List[str]] = []
    INDEX_PREFIX: ClassVar[str] = "index"

    def __init__(self, config: Dict):
        self.config = config
        self.url = config.get("url")
        self.username = config.get("username")
        self.password = config.get("password")
        self.api_key = config.get("apiKey")
        self.index_strategy = config.get("indexStrategy", {})
        self.ext = config.get("ext", {})

    def extract_chunk_text(self, raw_content: Any) -> str:
        if raw_content is None:
            return ""
        if not isinstance(raw_content, str):
            return str(raw_content)

        stripped = raw_content.strip()
        if not stripped.startswith("{") or '"text"' not in stripped:
            return raw_content

        try:
            data = json.loads(stripped)
        except Exception:
            return raw_content

        if isinstance(data, dict):
            text = data.get("text")
            if isinstance(text, str):
                return text
        return raw_content

    @classmethod
    def get_supported_retrieval_methods(cls) -> List[str]:
        return cls.SUPPORTED_RETRIEVAL_METHODS.copy()

    @abstractmethod
    def create_vector_store(self, index_name: str):
        pass

    @abstractmethod
    def index_with_metadata(
        self,
        nodes: List[BaseNode],
        chunk_metadata: ChunkMetadata,
        embed_model,
        **kwargs,
    ) -> Dict:
        pass
