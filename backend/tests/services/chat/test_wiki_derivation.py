# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for wiki document derivation in selected_knowledge (design §5.6/§5.7)."""

from types import SimpleNamespace

from app.models.knowledge import KnowledgeDocument
from app.services.chat.selected_knowledge import (
    _build_wegent_refs_for_ids,
    apply_selected_knowledge_context,
)
from shared.models.db import Kind
from shared.models.knowledge import (
    SelectedKnowledgeContext,
    SelectedKnowledgeRef,
)


def _wiki_doc(test_db, kb_id, path):
    document = KnowledgeDocument(
        kind_id=kb_id,
        name=f"wiki:{path}",
        file_extension="md",
        user_id=1,
        is_active=True,
        source_type="external_wiki",
        source_config={
            "wiki": {
                "path": path,
                "resource_url": f"https://wiki.example.com/{path}",
                "bound_by_user_id": 7,
                "bound_by": "alice",
            }
        },
    )
    test_db.add(document)
    test_db.commit()
    return document


def _kb(test_db):
    kb = Kind(
        user_id=1,
        kind="KnowledgeBase",
        name="kb-wiki",
        json={"spec": {"name": "kb-wiki"}},
    )
    test_db.add(kb)
    test_db.commit()
    return kb


def _task(spec=None):
    return SimpleNamespace(id=99, user_id=1, json={"spec": spec or {}})


class TestDerivation:
    def test_unscoped_selection_carries_all_wiki_documents(self, test_db):
        kb = _kb(test_db)
        _wiki_doc(test_db, kb.id, "docs/a")
        _wiki_doc(test_db, kb.id, "docs/b")
        refs = _build_wegent_refs_for_ids(test_db, _task(), [kb.id])
        wiki_refs = [ref for ref in refs if ref.provider == "wiki"]
        assert len(wiki_refs) == 2
        assert all(ref.knowledge_base_id == "wiki" for ref in wiki_refs)
        assert [ref.provider for ref in refs if ref.provider == "wegent"] == ["wegent"]

    def test_document_scope_carries_only_selected_wiki_rows(self, test_db):
        kb = _kb(test_db)
        selected = _wiki_doc(test_db, kb.id, "docs/keep")
        _wiki_doc(test_db, kb.id, "docs/skip")
        spec = {
            "knowledgeBaseScopes": [
                {
                    "id": kb.id,
                    "name": "kb-wiki",
                    "scopeRestricted": True,
                    "explicitDocumentIds": [selected.id, 42],
                }
            ]
        }
        refs = _build_wegent_refs_for_ids(test_db, _task(spec), [kb.id])
        wiki_refs = [ref for ref in refs if ref.provider == "wiki"]
        assert len(wiki_refs) == 1
        assert wiki_refs[0].resources[0].resource_id == "docs/keep"

    def test_folder_scope_carries_no_wiki(self, test_db):
        kb = _kb(test_db)
        _wiki_doc(test_db, kb.id, "docs/a")
        spec = {
            "knowledgeBaseScopes": [
                {
                    "id": kb.id,
                    "name": "kb-wiki",
                    "scopeRestricted": True,
                    "folderIds": [5],
                }
            ]
        }
        refs = _build_wegent_refs_for_ids(test_db, _task(spec), [kb.id])
        assert [ref.provider for ref in refs] == ["wegent"]

    def test_kb_without_wiki_documents_is_untouched(self, test_db):
        kb = _kb(test_db)
        refs = _build_wegent_refs_for_ids(test_db, _task(), [kb.id])
        assert [ref.provider for ref in refs] == ["wegent"]


def _request():
    return SimpleNamespace(
        selected_knowledge_prompt=None,
        provider_native_knowledge=None,
        preload_skills=[],
        user_selected_skills=[],
        bot=[{"shell_type": "Chat"}],
    )


def _wiki_ref():
    return SelectedKnowledgeRef(
        provider="wiki",
        knowledge_base_id="wiki",
        knowledge_base_name="外部 Wiki",
        resources=(),
    )


def _wegent_ref():
    return SelectedKnowledgeRef(
        provider="wegent", knowledge_base_id="5", knowledge_base_name="kb"
    )


class TestDegradation:
    def test_unavailable_wiki_replaced_by_guidance(self, monkeypatch):
        monkeypatch.setattr(
            "app.services.wiki.service.collect_wiki_scope_entries",
            lambda db, task, subtask_id: ([], ["「site」的添加者连接不可用"]),
        )
        context = SelectedKnowledgeContext(refs=(_wiki_ref(),))
        skills = apply_selected_knowledge_context(
            None, _request(), _task(), context=context
        )
        assert skills == []
        request = _request()
        apply_selected_knowledge_context(None, request, _task(), context=context)
        assert "添加者" in request.selected_knowledge_prompt
        assert "<selected_knowledge_warnings>" in request.selected_knowledge_prompt

    def test_resolvable_documents_keep_refs_and_activate_skill(self, monkeypatch):
        monkeypatch.setattr(
            "app.services.wiki.service.collect_wiki_scope_entries",
            lambda db, task, subtask_id: ([SimpleNamespace(path="docs/a")], []),
        )
        request = _request()
        context = SelectedKnowledgeContext(refs=(_wegent_ref(), _wiki_ref()))
        skills = apply_selected_knowledge_context(
            None, request, _task(), context=context
        )
        assert skills == ["wegent-knowledge", "external-wiki"]
        assert "external-wiki" in request.preload_skills
        assert "<selected_knowledge_sources>" in request.selected_knowledge_prompt

    def test_internal_only_selection_skips_wiki_check(self, monkeypatch):
        def unexpected(db, task, subtask_id):
            raise AssertionError("wiki scopes must not resolve without wiki refs")

        monkeypatch.setattr(
            "app.services.wiki.service.collect_wiki_scope_entries", unexpected
        )
        request = _request()
        context = SelectedKnowledgeContext(refs=(_wegent_ref(),))
        skills = apply_selected_knowledge_context(
            None, request, _task(), context=context
        )
        assert skills == ["wegent-knowledge"]
