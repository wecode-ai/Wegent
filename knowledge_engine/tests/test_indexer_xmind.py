# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import json
import zipfile
from unittest.mock import MagicMock

from knowledge_engine.index.indexer import DocumentIndexer
from knowledge_engine.storage.chunk_metadata import ChunkMetadata


def _build_xmind_archive() -> bytes:
    content = [
        {
            "title": "Planning",
            "rootTopic": {
                "title": "Roadmap",
                "children": {
                    "attached": [
                        {"title": "Discovery"},
                        {"title": "Implementation"},
                    ]
                },
            },
        }
    ]
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("content.json", json.dumps(content))
    return archive.getvalue()


def test_index_from_binary_extracts_xmind_topics_for_indexing() -> None:
    storage_backend = MagicMock()
    storage_backend.index_with_metadata.return_value = {
        "indexed_count": 1,
        "index_name": "wegent_kb_1",
        "status": "success",
    }
    chunk_metadata = ChunkMetadata(
        knowledge_id="1",
        doc_ref="9",
        source_file="roadmap.xmind",
        created_at="2026-04-24T00:00:00+00:00",
    )

    indexer = DocumentIndexer(
        storage_backend=storage_backend,
        embed_model=MagicMock(),
        splitter_config={
            "chunk_strategy": "flat",
            "format_enhancement": "file_aware",
            "flat_config": {
                "chunk_size": 1024,
                "chunk_overlap": 50,
                "separator": "\n\n",
            },
            "markdown_enhancement": {"enabled": True},
        },
        file_extension=".xmind",
    )

    result = indexer.index_from_binary(
        binary_data=_build_xmind_archive(),
        file_extension=".xmind",
        chunk_metadata=chunk_metadata,
        user_id=7,
    )

    chunk_text = result["chunks_data"]["items"][0]["content"]
    assert "# Planning" in chunk_text
    assert "- Roadmap" in chunk_text
    assert "Roadmap" in chunk_text
    assert "Discovery" in chunk_text
    assert "Implementation" in chunk_text
    storage_backend.index_with_metadata.assert_called_once()
