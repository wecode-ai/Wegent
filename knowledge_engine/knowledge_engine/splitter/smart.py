# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List

from langchain_text_splitters import RecursiveCharacterTextSplitter
from llama_index.core import Document
from llama_index.core.node_parser import (
    LangchainNodeParser,
    MarkdownNodeParser,
    SentenceSplitter,
)
from llama_index.core.schema import BaseNode

from knowledge_engine.splitter.file_aware import (
    FILE_AWARE_EXTENSIONS,
    resolve_file_aware_parser_subtype,
    supports_file_aware_split,
)
from knowledge_engine.splitter.markdown_enhancement import enhance_markdown_nodes
from shared.telemetry.decorators import set_span_attribute, trace_sync


class SmartSplitter:
    SMART_EXTENSIONS = FILE_AWARE_EXTENSIONS
    DEFAULT_CHUNK_SIZE = 1024
    DEFAULT_CHUNK_OVERLAP = 50

    def __init__(
        self,
        file_extension: str,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
        markdown_enhancement_enabled: bool = False,
    ):
        self.file_extension = file_extension.lower()
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.markdown_enhancement_enabled = markdown_enhancement_enabled

    @classmethod
    def supports_smart_split(cls, file_extension: str) -> bool:
        return supports_file_aware_split(file_extension)

    @trace_sync("rag.splitter.split_documents")
    def split_documents(self, documents: List[Document]) -> List[BaseNode]:
        set_span_attribute("file_extension", self.file_extension)
        set_span_attribute("chunk_size", self.chunk_size)
        set_span_attribute("chunk_overlap", self.chunk_overlap)

        parser_subtype = resolve_file_aware_parser_subtype(self.file_extension)
        if parser_subtype == "markdown_sentence":
            return self._split_markdown(documents)
        if parser_subtype == "sentence":
            return self._split_text(documents)
        return self._split_recursive(documents)

    def _split_markdown(self, documents: List[Document]) -> List[BaseNode]:
        markdown_parser = MarkdownNodeParser()
        nodes = markdown_parser.get_nodes_from_documents(documents)
        if self.markdown_enhancement_enabled:
            nodes = enhance_markdown_nodes(nodes)
        sentence_splitter = SentenceSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )
        intermediate_docs = [
            Document(text=node.text, metadata=node.metadata) for node in nodes
        ]
        return sentence_splitter.get_nodes_from_documents(intermediate_docs)

    def _split_text(self, documents: List[Document]) -> List[BaseNode]:
        splitter = SentenceSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
        )
        return splitter.get_nodes_from_documents(documents)

    def _split_recursive(self, documents: List[Document]) -> List[BaseNode]:
        lc_splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
            separators=["\n\n", "\n", " ", ""],
        )
        parser = LangchainNodeParser(lc_splitter=lc_splitter)
        return parser.get_nodes_from_documents(documents)

    def _get_subtype(self) -> str:
        return resolve_file_aware_parser_subtype(self.file_extension)
