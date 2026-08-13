from app.services.chat.external_knowledge_refs import merge_external_knowledge_refs


def _ref(target_type: str, node_id: str | None = None) -> dict[str, str]:
    ref = {
        "provider": "dingtalk",
        "mode": "explicit",
        "id": "space-d",
        "target_type": target_type,
    }
    if node_id is not None:
        ref["node_id"] = node_id
    return ref


def test_whole_knowledge_base_dominates_descendants_in_same_batch() -> None:
    incoming = [
        _ref("knowledge_base"),
        _ref("folder", "folder-d"),
        _ref("document", "doc-d1"),
    ]

    merged = merge_external_knowledge_refs([], incoming)

    assert merged == [_ref("knowledge_base")]


def test_later_child_selection_can_narrow_existing_whole_knowledge_base() -> None:
    existing = [_ref("knowledge_base")]
    incoming = [_ref("document", "doc-d1")]

    merged = merge_external_knowledge_refs(existing, incoming)

    assert merged == [_ref("document", "doc-d1")]
