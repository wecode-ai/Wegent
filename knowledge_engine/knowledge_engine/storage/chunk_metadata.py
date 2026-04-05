# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List

from llama_index.core.schema import BaseNode


@dataclass
class ChunkMetadata:
    knowledge_id: str
    doc_ref: str
    source_file: str
    created_at: str
    chunk_index: int = field(default=0)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def with_chunk_index(self, chunk_index: int) -> "ChunkMetadata":
        return ChunkMetadata(
            knowledge_id=self.knowledge_id,
            doc_ref=self.doc_ref,
            source_file=self.source_file,
            created_at=self.created_at,
            chunk_index=chunk_index,
        )

    def apply_to_nodes(self, nodes: List[BaseNode]) -> List[BaseNode]:
        for idx, node in enumerate(nodes):
            node.metadata.update(self.with_chunk_index(idx).to_dict())
        return nodes
