# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import logging
from unittest.mock import MagicMock, patch

import pytest

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.schemas.external_knowledge import (
    ExternalKnowledgeRef,
    external_ref_canonical_key,
)
from app.services.context.context_service import context_service
from app.services.knowledge.retrieval_persistence import RetrievalPersistenceService


@pytest.mark.unit
class TestRetrievalPersistenceService:
    def setup_method(self) -> None:
        self.service = RetrievalPersistenceService()

    def test_persist_retrieval_result_skips_missing_user_subtask_id(self) -> None:
        db = MagicMock()

        self.service.persist_retrieval_result(
            db=db,
            user_subtask_id=None,
            user_id=7,
            query="q",
            mode="rag_retrieval",
            records=[{"knowledge_base_id": 1, "title": "doc", "content": "chunk"}],
        )

        db.assert_not_called()

    def test_prepare_payload_redacts_titles_in_restricted_mode(self) -> None:
        payload = self.service._prepare_persistence_payload(
            records=[
                {
                    "knowledge_base_id": 1,
                    "title": "salary-plan.md",
                    "content": "hidden",
                    "score": 0.9,
                }
            ],
            restricted_mode=True,
        )

        assert payload[1]["sources"][0]["title"] == "Source 1"

    def test_build_extracted_text_includes_content_for_normal_mode(self) -> None:
        """Normal persistence should keep chunk content and sources."""
        result = self.service._build_extracted_text(
            kb_id=1,
            chunks=[
                {
                    "content": "test content",
                    "source": "doc.md",
                    "score": 0.85,
                    "knowledge_base_id": 1,
                    "source_index": 1,
                }
            ],
            sources=[{"index": 1, "title": "doc.md", "kb_id": 1}],
            restricted_mode=False,
        )

        data = json.loads(result)
        assert data["chunks"][0]["content"] == "test content"
        assert data["chunks"][0]["source"] == "doc.md"
        assert data["sources"][0]["title"] == "doc.md"

    def test_build_extracted_text_omits_content_for_restricted_mode(self) -> None:
        """Restricted persistence should redact raw chunk content."""
        result = self.service._build_extracted_text(
            kb_id=1,
            chunks=[
                {
                    "content": "sensitive original content",
                    "source": "Source 1",
                    "score": 0.85,
                    "knowledge_base_id": 1,
                    "source_index": 1,
                }
            ],
            sources=[{"index": 1, "title": "Source 1", "kb_id": 1}],
            restricted_mode=True,
        )

        data = json.loads(result)
        assert data["restricted_mode"] is True
        assert "original content withheld" in data["message"].lower()
        assert "content" not in data["chunks"][0]
        assert "sensitive original content" not in result

    def test_persist_retrieval_result_creates_context_for_missing_record(self) -> None:
        """Persistence should auto-create KB context when it does not exist."""
        db = MagicMock()
        records = [
            {
                "content": "chunk 1",
                "title": "doc.md",
                "score": 0.9,
                "knowledge_base_id": 7,
            },
            {
                "content": "chunk 2",
                "title": "doc.md",
                "score": 0.8,
                "knowledge_base_id": 7,
            },
        ]

        mock_get_context_map = MagicMock(return_value={})
        mock_create_context = MagicMock(return_value=MagicMock(id=101))

        with patch.multiple(
            context_service,
            get_knowledge_base_context_map_by_subtask=mock_get_context_map,
            create_knowledge_base_context_with_result=mock_create_context,
        ):
            self.service.persist_retrieval_result(
                db=db,
                user_subtask_id=12,
                user_id=34,
                query="search query",
                mode="rag_retrieval",
                records=records,
                restricted_mode=False,
            )

        mock_create_context.assert_called_once()
        mock_get_context_map.assert_called_once_with(
            db=db,
            subtask_id=12,
            knowledge_ids=[7],
        )
        result_data = mock_create_context.call_args.kwargs["result_data"]
        assert result_data["query"] == "search query"
        assert result_data["injection_mode"] == "rag_retrieval"
        assert result_data["chunks_count"] == 2
        assert len(result_data["sources"]) == 1
        extracted = json.loads(result_data["extracted_text"])
        assert len(extracted["chunks"]) == 2
        assert extracted["chunks"][0]["source_index"] == 1

    def test_persist_retrieval_result_updates_existing_context_for_direct_injection(
        self,
    ) -> None:
        """Direct injection persistence should update context without extracted text."""
        db = MagicMock()
        records = [
            {
                "content": "full content",
                "title": "doc.md",
                "score": None,
                "knowledge_base_id": 9,
            }
        ]
        existing_context = MagicMock(id=88)

        mock_get_context_map = MagicMock(return_value={9: existing_context})
        mock_update_context = MagicMock()

        with patch.multiple(
            context_service,
            get_knowledge_base_context_map_by_subtask=mock_get_context_map,
            update_knowledge_base_retrieval_result=mock_update_context,
        ):
            self.service.persist_retrieval_result(
                db=db,
                user_subtask_id=66,
                user_id=77,
                query="search query",
                mode="direct_injection",
                records=records,
                restricted_mode=True,
            )

        mock_update_context.assert_called_once()
        mock_get_context_map.assert_called_once_with(
            db=db,
            subtask_id=66,
            knowledge_ids=[9],
        )
        update_kwargs = mock_update_context.call_args.kwargs
        assert update_kwargs["context_id"] == 88
        assert update_kwargs["extracted_text"] == ""
        assert update_kwargs["restricted_mode"] is True
        assert update_kwargs["sources"][0]["title"] == "Source 1"

    def test_persist_retrieval_result_allows_zero_user_id(self) -> None:
        """Persistence should allow user_id=0 when control-plane validation does."""
        db = MagicMock()

        mock_get_context_map = MagicMock(return_value={})
        mock_create_context = MagicMock(return_value=MagicMock(id=101))
        mock_update_context = MagicMock()

        with patch.multiple(
            context_service,
            get_knowledge_base_context_map_by_subtask=mock_get_context_map,
            create_knowledge_base_context_with_result=mock_create_context,
            update_knowledge_base_retrieval_result=mock_update_context,
        ):
            self.service.persist_retrieval_result(
                db=db,
                user_subtask_id=12,
                user_id=0,
                query="search query",
                mode="rag_retrieval",
                records=[
                    {
                        "content": "chunk 1",
                        "title": "doc.md",
                        "score": 0.9,
                        "knowledge_base_id": 7,
                    }
                ],
                restricted_mode=False,
            )

        mock_get_context_map.assert_called_once_with(
            db=db,
            subtask_id=12,
            knowledge_ids=[7],
        )
        mock_create_context.assert_called_once()
        mock_update_context.assert_not_called()

    def test_persist_retrieval_result_swallows_context_errors(self, caplog) -> None:
        """Persistence failures must not fail the main retrieval flow."""
        db = MagicMock()

        with (
            patch.object(
                context_service,
                "get_knowledge_base_context_map_by_subtask",
                side_effect=RuntimeError("db write failed"),
            ),
            caplog.at_level(
                logging.WARNING,
                logger="app.services.knowledge.retrieval_persistence",
            ),
        ):
            self.service.persist_retrieval_result(
                db=db,
                user_subtask_id=12,
                user_id=34,
                query="search query",
                mode="rag_retrieval",
                records=[
                    {
                        "content": "chunk 1",
                        "title": "doc.md",
                        "score": 0.9,
                        "knowledge_base_id": 7,
                    }
                ],
                restricted_mode=False,
            )

        assert "Failed to persist retrieval result" in caplog.text

    def test_persist_external_retrieval_result_creates_external_context(
        self,
        test_db,
    ) -> None:
        """External provider records should be stored as external contexts."""
        refs = [
            ExternalKnowledgeRef(
                provider="ap",
                mode="explicit",
                id="kb-1",
                name="Quarterly",
                target_type="knowledge_base",
            )
        ]

        self.service.persist_external_retrieval_result(
            db=test_db,
            user_subtask_id=42,
            user_id=7,
            query="plan",
            mode="rag_retrieval",
            records=[
                {
                    "content": "external plan content",
                    "title": "Plan.pdf",
                    "score": 0.91,
                    "source_type": "ap",
                    "source_id": "kb-1",
                    "source_name": "Quarterly",
                    "source_uri": "ap://kb-1/doc-1",
                    "document_id": "doc-1",
                }
            ],
            refs=refs,
        )

        context = (
            test_db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == 42,
                SubtaskContext.context_type == ContextType.EXTERNAL_KNOWLEDGE.value,
            )
            .one()
        )
        assert context.name == "Quarterly"
        assert context.status == ContextStatus.READY.value
        assert context.type_data["external_ref"]["provider"] == "ap"
        assert context.type_data["external_ref"]["id"] == "kb-1"
        assert context.type_data["retrieval_status"]["searched"] is True
        assert context.type_data["rag_result"]["chunks_count"] == 1

        extracted = json.loads(context.extracted_text)
        assert extracted["external_knowledge"] is True
        assert extracted["chunks"][0]["content"] == "external plan content"
        assert extracted["sources"][0]["source_uri"] == "ap://kb-1/doc-1"

    def test_external_retrieval_payload_matches_string_document_id_from_metadata(
        self,
    ) -> None:
        """External providers may use string document IDs carried in metadata."""
        refs = [
            ExternalKnowledgeRef(
                provider="dingtalk",
                mode="explicit",
                id="docs",
                target_type="document",
                document_id="doc-1",
                target_name="Launch Plan",
            )
        ]

        payload_by_ref = self.service._prepare_external_persistence_payload(
            records=[
                {
                    "content": "external chunk",
                    "title": "Launch Plan",
                    "source_type": "dingtalk",
                    "source_id": "docs",
                    "source_name": "DingTalk Docs",
                    "metadata": {"document_id": "doc-1"},
                }
            ],
            refs=refs,
        )

        ref_key = self.service._external_ref_key(refs[0].model_dump(exclude_none=True))
        assert list(payload_by_ref) == [ref_key]
        assert payload_by_ref[ref_key]["external_ref"]["document_id"] == "doc-1"

    def test_persist_external_retrieval_result_updates_existing_context(
        self,
        test_db,
    ) -> None:
        """External context persistence should update the selected source context."""
        existing = SubtaskContext(
            subtask_id=43,
            user_id=7,
            context_type=ContextType.EXTERNAL_KNOWLEDGE.value,
            name="Old name",
            status=ContextStatus.READY.value,
            extracted_text="{}",
            type_data={
                "external_ref": {
                    "provider": "ap",
                    "mode": "explicit",
                    "id": "kb-1",
                    "target_type": "knowledge_base",
                },
                "rag_result": {"retrieval_count": 2},
            },
        )
        test_db.add(existing)
        test_db.commit()

        self.service.persist_external_retrieval_result(
            db=test_db,
            user_subtask_id=43,
            user_id=7,
            query="plan",
            mode="rag_retrieval",
            records=[
                {
                    "content": "updated external content",
                    "title": "Updated.pdf",
                    "score": 0.8,
                    "source_type": "ap",
                    "source_id": "kb-1",
                    "source_name": "Quarterly",
                    "document_id": "doc-2",
                }
            ],
            refs=[
                {
                    "provider": "ap",
                    "mode": "explicit",
                    "id": "kb-1",
                    "target_type": "knowledge_base",
                }
            ],
        )

        context = (
            test_db.query(SubtaskContext).filter(SubtaskContext.id == existing.id).one()
        )
        assert context.name == "Quarterly"
        assert context.type_data["rag_result"]["retrieval_count"] == 3
        extracted = json.loads(context.extracted_text)
        assert extracted["chunks"][0]["content"] == "updated external content"

    def test_persist_external_retrieval_result_records_no_hit_without_records(
        self,
        test_db,
    ) -> None:
        """Empty provider results should still persist retrieval status."""
        self.service.persist_external_retrieval_result(
            db=test_db,
            user_subtask_id=44,
            user_id=7,
            query="missing",
            mode="rag_retrieval",
            records=[],
            refs=[
                {
                    "provider": "ap",
                    "mode": "explicit",
                    "id": "kb-empty",
                    "name": "Empty KB",
                    "target_type": "knowledge_base",
                }
            ],
            source_summaries=[
                {
                    "provider": "ap",
                    "searched_source_ids": ["kb-empty"],
                    "ignored_source_ids": [],
                    "source_statuses": [{"source_id": "kb-empty", "status": "no_hit"}],
                }
            ],
        )

        context = (
            test_db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == 44,
                SubtaskContext.context_type == ContextType.EXTERNAL_KNOWLEDGE.value,
            )
            .one()
        )
        assert context.name == "Empty KB"
        assert context.extracted_text == ""
        assert context.type_data["retrieval_status"] == {
            "searched": True,
            "ignored": False,
            "warning_reason": "no_hit",
        }
        assert context.type_data["rag_result"]["chunks_count"] == 0

    @pytest.mark.parametrize("other_status", ["no_hit", "failed"])
    def test_statuses_with_same_source_id_match_full_canonical_ref(
        self,
        test_db,
        other_status,
    ) -> None:
        """Sibling DingTalk targets must not reuse each other's status."""
        hit_ref = {
            "provider": "dingtalk",
            "mode": "explicit",
            "id": "docs",
            "target_type": "document",
            "document_id": "doc-hit",
        }
        other_ref = {
            "provider": "dingtalk",
            "mode": "explicit",
            "id": "docs",
            "target_type": "folder",
            "workspace_id": "workspace-1",
            "node_id": "folder-other",
        }
        summaries = [
            {
                "provider": "dingtalk",
                "searched_source_ids": ["docs"],
                "ignored_source_ids": [],
                "source_statuses": [
                    {
                        "source_id": "docs",
                        "canonical_ref_key": external_ref_canonical_key(hit_ref),
                        "status": "hit",
                    },
                    {
                        "source_id": "docs",
                        "canonical_ref_key": external_ref_canonical_key(other_ref),
                        "status": other_status,
                    },
                ],
            }
        ]

        self.service.persist_external_retrieval_result(
            db=test_db,
            user_subtask_id=45,
            user_id=7,
            query="targeted",
            mode="rag_retrieval",
            records=[
                {
                    "content": "hit",
                    "title": "Hit",
                    "source_type": "dingtalk",
                    "source_id": "docs",
                    "metadata": {
                        "canonical_ref_key": external_ref_canonical_key(hit_ref),
                        "document_id": "doc-hit",
                    },
                }
            ],
            refs=[hit_ref, other_ref],
            source_summaries=summaries,
        )

        contexts = (
            test_db.query(SubtaskContext)
            .filter(SubtaskContext.subtask_id == 45)
            .order_by(SubtaskContext.id)
            .all()
        )
        statuses = {
            external_ref_canonical_key(
                context.type_data["external_ref"]
            ): context.type_data["retrieval_status"]
            for context in contexts
        }
        assert statuses[external_ref_canonical_key(hit_ref)]["searched"] is True
        assert statuses[external_ref_canonical_key(hit_ref)]["warning_reason"] is None
        assert statuses[external_ref_canonical_key(other_ref)]["warning_reason"] == (
            "no_hit" if other_status == "no_hit" else "provider_failed"
        )
        assert all(
            context.type_data["rag_result"]["knowledge_source_type"] == "external"
            for context in contexts
        )

    def test_persist_external_retrieval_result_records_ignored_without_records(
        self,
        test_db,
    ) -> None:
        """Ignored provider refs should be visible even when no chunks return."""
        self.service.persist_external_retrieval_result(
            db=test_db,
            user_subtask_id=45,
            user_id=7,
            query="ignored",
            mode="rag_retrieval",
            records=[],
            refs=[
                {
                    "provider": "dingtalk",
                    "mode": "explicit",
                    "id": "docs",
                    "name": "DingTalk Docs",
                    "target_type": "document",
                    "document_id": "doc-1",
                    "target_name": "Roadmap.md",
                }
            ],
            source_summaries=[
                {
                    "provider": "dingtalk",
                    "searched_source_ids": [],
                    "ignored_source_ids": ["docs"],
                }
            ],
        )

        context = (
            test_db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == 45,
                SubtaskContext.context_type == ContextType.EXTERNAL_KNOWLEDGE.value,
            )
            .one()
        )
        assert context.extracted_text == ""
        assert context.type_data["external_ref"]["target_name"] == "Roadmap.md"
        assert context.type_data["retrieval_status"] == {
            "searched": False,
            "ignored": True,
            "warning_reason": "external_source_ignored",
        }

    def test_external_ref_key_defaults_target_type_to_knowledge_base(self) -> None:
        """_external_ref_key must default target_type to match canonical key shape."""
        ref = {
            "provider": "ap",
            "mode": "explicit",
            "id": "kb-1",
        }
        key = self.service._external_ref_key(ref)
        assert key == ("ap", "explicit", "kb-1", "knowledge_base", None, None, None)

    def test_external_ref_key_matches_canonical_key_shape(self) -> None:
        """_external_ref_key and external_ref_canonical_key must align on shape."""
        ref = {
            "provider": "ap",
            "mode": "explicit",
            "id": "kb-1",
            "workspace_id": "ws-1",
            "node_id": "node-1",
            "document_id": "doc-1",
        }
        tuple_key = self.service._external_ref_key(ref)
        canonical_key = external_ref_canonical_key(ref)
        assert ":".join(
            str(p) if p is not None else "" for p in tuple_key
        ) == canonical_key.replace("external:", "", 1)

    def test_external_ref_key_groups_missing_and_default_target_type_together(
        self,
    ) -> None:
        """Refs with no target_type and refs with explicit knowledge_base must share slot."""
        ref_a = {"provider": "ap", "mode": "explicit", "id": "kb-1"}
        ref_b = {
            "provider": "ap",
            "mode": "explicit",
            "id": "kb-1",
            "target_type": "knowledge_base",
        }
        key_a = self.service._external_ref_key(ref_a)
        key_b = self.service._external_ref_key(ref_b)
        assert key_a == key_b

    def test_external_persistence_does_not_commit_per_ref(self, test_db) -> None:
        """persist_external_retrieval_result must flush, never commit, per ref."""
        refs = [
            ExternalKnowledgeRef(
                provider="ap", mode="explicit", id="kb-1", target_type="knowledge_base"
            ),
            ExternalKnowledgeRef(
                provider="ap", mode="explicit", id="kb-2", target_type="knowledge_base"
            ),
        ]
        records = [
            {
                "content": "first",
                "title": "A",
                "source_type": "ap",
                "source_id": "kb-1",
                "source_name": "KB1",
                "document_id": "doc-1",
            },
            {
                "content": "second",
                "title": "B",
                "source_type": "ap",
                "source_id": "kb-2",
                "source_name": "KB2",
                "document_id": "doc-2",
            },
        ]

        with patch.object(test_db, "commit", wraps=test_db.commit) as spy_commit:
            self.service.persist_external_retrieval_result(
                db=test_db,
                user_subtask_id=61,
                user_id=7,
                query="plan",
                mode="rag_retrieval",
                records=records,
                refs=refs,
            )
            spy_commit.assert_not_called()

        # The rows are visible within the session (flushed) but not yet committed.
        contexts = (
            test_db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == 61,
                SubtaskContext.context_type == ContextType.EXTERNAL_KNOWLEDGE.value,
            )
            .all()
        )
        assert len(contexts) == 2

    def test_external_persistence_all_committed_by_caller(self, test_db) -> None:
        """When the caller commits, all external contexts persist together."""
        refs = [
            ExternalKnowledgeRef(
                provider="ap", mode="explicit", id="kb-1", target_type="knowledge_base"
            ),
            ExternalKnowledgeRef(
                provider="ap", mode="explicit", id="kb-2", target_type="knowledge_base"
            ),
        ]
        records = [
            {
                "content": "first",
                "title": "A",
                "source_type": "ap",
                "source_id": "kb-1",
                "source_name": "KB1",
                "document_id": "doc-1",
            },
            {
                "content": "second",
                "title": "B",
                "source_type": "ap",
                "source_id": "kb-2",
                "source_name": "KB2",
                "document_id": "doc-2",
            },
        ]

        self.service.persist_external_retrieval_result(
            db=test_db,
            user_subtask_id=62,
            user_id=7,
            query="plan",
            mode="rag_retrieval",
            records=records,
            refs=refs,
        )
        test_db.commit()

        contexts = (
            test_db.query(SubtaskContext).filter(SubtaskContext.subtask_id == 62).all()
        )
        assert len(contexts) == 2

    def test_external_persistence_caller_rollback_leaves_no_residue(
        self, test_db
    ) -> None:
        """Caller rollback after persistence must remove all flushed external rows."""
        refs = [
            ExternalKnowledgeRef(
                provider="ap", mode="explicit", id="kb-1", target_type="knowledge_base"
            ),
        ]
        records = [
            {
                "content": "first",
                "title": "A",
                "source_type": "ap",
                "source_id": "kb-1",
                "source_name": "KB1",
                "document_id": "doc-1",
            },
        ]

        self.service.persist_external_retrieval_result(
            db=test_db,
            user_subtask_id=63,
            user_id=7,
            query="plan",
            mode="rag_retrieval",
            records=records,
            refs=refs,
        )
        test_db.rollback()

        contexts = (
            test_db.query(SubtaskContext).filter(SubtaskContext.subtask_id == 63).all()
        )
        assert contexts == []
