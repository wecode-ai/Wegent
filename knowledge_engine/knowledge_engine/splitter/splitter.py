# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List

from llama_index.core import Document
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.node_parser import (
    SemanticSplitterNodeParser,
)
from llama_index.core.node_parser import SentenceSplitter as LlamaIndexSentenceSplitter
from llama_index.core.schema import BaseNode


class SemanticSplitter:
    def __init__(
        self,
        embed_model: BaseEmbedding,
        buffer_size: int = 1,
        breakpoint_percentile_threshold: int = 95,
    ):
        self.embed_model = embed_model
        self.buffer_size = buffer_size
        self.breakpoint_percentile_threshold = breakpoint_percentile_threshold
        self.splitter = SemanticSplitterNodeParser(
            buffer_size=buffer_size,
            breakpoint_percentile_threshold=breakpoint_percentile_threshold,
            embed_model=embed_model,
        )

    def split_documents(self, documents: List[Document]) -> List[BaseNode]:
        return self.splitter.get_nodes_from_documents(documents)


class SentenceSplitter:
    def __init__(
        self,
        chunk_size: int = 1024,
        chunk_overlap: int = 200,
        separator: str = " ",
        paragraph_separator: str | None = None,
    ):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.separator = separator
        self.paragraph_separator = paragraph_separator or separator
        self.splitter = LlamaIndexSentenceSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            separator=separator,
            paragraph_separator=self.paragraph_separator,
        )

    def split_documents(self, documents: List[Document]) -> List[BaseNode]:
        return self.splitter.get_nodes_from_documents(documents)


DocumentSplitter = SemanticSplitter
