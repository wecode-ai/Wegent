# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.models.knowledge import SelectedKnowledgeRef, SelectedKnowledgeResource
from shared.selected_knowledge import resolve_selected_knowledge_context


def _ref(
    provider: str,
    knowledge_base_id: str,
    *resources: SelectedKnowledgeResource,
) -> SelectedKnowledgeRef:
    return SelectedKnowledgeRef(
        provider=provider,
        knowledge_base_id=knowledge_base_id,
        knowledge_base_name=knowledge_base_id,
        resources=resources,
    )


def test_explicit_refs_merge_with_unrelated_task_refs() -> None:
    context = resolve_selected_knowledge_context(
        task_refs=[_ref("wegent", "default-a"), _ref("dingtalk", "default-b")],
        explicit_refs=[_ref("dingtalk", "selected-c")],
    )

    assert [(ref.provider, ref.knowledge_base_id) for ref in context.refs] == [
        ("wegent", "default-a"),
        ("dingtalk", "default-b"),
        ("dingtalk", "selected-c"),
    ]
    assert context.evidence_required is True


def test_explicit_ref_replaces_task_scope_for_same_knowledge_base() -> None:
    default_document = SelectedKnowledgeResource(
        scope_type="document",
        resource_id="default-doc",
    )
    selected_document = SelectedKnowledgeResource(
        scope_type="document",
        resource_id="selected-doc",
    )
    context = resolve_selected_knowledge_context(
        task_refs=[_ref("wegent", "kb-1", default_document)],
        explicit_refs=[_ref("wegent", "kb-1", selected_document)],
    )

    assert context.refs[0].resources == (selected_document,)


def test_task_refs_are_used_without_explicit_selection() -> None:
    context = resolve_selected_knowledge_context(
        task_refs=[_ref("wegent", "default-a"), _ref("dingtalk", "default-b")],
        explicit_refs=[],
    )

    assert [(ref.provider, ref.knowledge_base_id) for ref in context.refs] == [
        ("wegent", "default-a"),
        ("dingtalk", "default-b"),
    ]
    assert context.evidence_required is False


def test_same_knowledge_base_resources_merge_and_whole_scope_wins() -> None:
    folder = SelectedKnowledgeResource(scope_type="folder", resource_id="folder-1")
    document = SelectedKnowledgeResource(scope_type="document", resource_id="doc-1")

    scoped = resolve_selected_knowledge_context(
        task_refs=[],
        explicit_refs=[
            _ref("dingtalk", "kb-1", folder),
            _ref("dingtalk", "kb-1", document),
            _ref("dingtalk", "kb-1", document),
        ],
    )
    whole = resolve_selected_knowledge_context(
        task_refs=[],
        explicit_refs=[
            _ref("dingtalk", "kb-1", folder),
            _ref("dingtalk", "kb-1"),
        ],
    )

    assert scoped.refs[0].resources == (folder, document)
    assert whole.refs[0].resources == ()


def test_duplicate_refs_preserve_routing_metadata() -> None:
    first = SelectedKnowledgeRef(
        provider="wegent",
        knowledge_base_id="kb-1",
        knowledge_base_name="知识库",
        resources=(
            SelectedKnowledgeResource(scope_type="folder", resource_id="folder-1"),
        ),
        routing_summary="产品发布流程",
        routing_topics=("产品",),
    )
    second = SelectedKnowledgeRef(
        provider="wegent",
        knowledge_base_id="kb-1",
        knowledge_base_name="知识库",
        resources=(
            SelectedKnowledgeResource(scope_type="document", resource_id="doc-1"),
        ),
        routing_topics=("发布", "产品"),
        retrieval_capabilities={"retrieval_mode": "hybrid"},
    )

    context = resolve_selected_knowledge_context([], [first, second])

    assert context.refs[0].routing_summary == "产品发布流程"
    assert context.refs[0].routing_topics == ("产品", "发布")
    assert context.refs[0].retrieval_capabilities == {"retrieval_mode": "hybrid"}
