"""Selected-document access is an overall action, independent of row order."""

import pytest

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.models.subtask_context import SubtaskContext
from tests.permission_fixtures import permission_subject  # noqa: F401


@pytest.mark.parametrize("correlated", [False, True])
@pytest.mark.parametrize("reverse", [False, True])
def test_selected_documents_keep_determined_denial(
    test_db, permission_subject, reverse, correlated
):
    from app.services.chat.preprocessing.selected_documents import (
        process_selected_documents_contexts,
    )

    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    groups = [
        Namespace(name="unknown-batch", owner_user_id=1, is_active=True),
        Namespace(name="denied-batch", owner_user_id=1, is_active=True),
    ]
    test_db.add_all(groups)
    test_db.flush()
    bindings = (
        [
            (groups[0], "user", str(viewer.id), "RestrictedAnalyst"),
            (groups[0], "directory_group", "D0", "Developer"),
            (groups[1], "directory_group", "D0", "RestrictedAnalyst"),
        ]
        if correlated
        else [
            (groups[0], "directory_group", "D0", "RestrictedAnalyst"),
            (groups[1], "user", str(viewer.id), "RestrictedAnalyst"),
        ]
    )
    for group, entity_type, entity_id, role in bindings:
        test_db.add(
            ResourceMember(
                resource_type="Namespace",
                resource_id=group.id,
                entity_type=entity_type,
                entity_id=entity_id,
                role=role,
                status="approved",
            )
        )
    documents = []
    for kb_id, group in zip(ids, reversed(groups) if reverse else groups):
        test_db.get(Kind, kb_id).namespace = group.name
        document = KnowledgeDocument(
            kind_id=kb_id,
            user_id=1,
            name="private",
            file_extension="txt",
            source_type="text",
            status="enabled",
            is_active=True,
        )
        test_db.add(document)
        documents.append(document)
    test_db.flush()
    contexts = [
        SubtaskContext(
            type_data={"knowledge_base_id": doc.kind_id, "document_ids": [doc.id]}
        )
        for doc in documents
    ]
    message, prompt, tools = process_selected_documents_contexts(
        test_db, contexts, viewer.id, "question", "system", []
    )
    assert message == "question"
    assert "Restricted Analyst" in prompt
    assert tools == []
    assert directory.call_count == 1


def test_selected_documents_inject_when_unknown_cannot_restrict(
    test_db, permission_subject
):
    from app.models.subtask_context import ContextStatus, ContextType
    from app.services.chat.preprocessing.selected_documents import (
        process_selected_documents_contexts,
    )

    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    group = Namespace(name="selection-readable", owner_user_id=1, is_active=True)
    test_db.add(group)
    test_db.flush()
    for kind, eid, role in [
        ("user", str(viewer.id), "Developer"),
        ("directory_group", "D0", "Maintainer"),
    ]:
        test_db.add(
            ResourceMember(
                resource_type="Namespace",
                resource_id=group.id,
                entity_type=kind,
                entity_id=eid,
                role=role,
                status="approved",
            )
        )
    test_db.get(Kind, ids[0]).namespace = group.name
    attachment = SubtaskContext(
        user_id=viewer.id,
        name="source.txt",
        context_type=ContextType.ATTACHMENT.value,
        status=ContextStatus.READY.value,
        extracted_text="permitted source",
    )
    test_db.add(attachment)
    test_db.flush()
    document = KnowledgeDocument(
        kind_id=ids[0],
        user_id=viewer.id,
        name="source",
        file_extension="txt",
        attachment_id=attachment.id,
        status="enabled",
        is_active=True,
    )
    test_db.add(document)
    test_db.flush()
    context = SubtaskContext(
        type_data={"knowledge_base_id": ids[0], "document_ids": [document.id]}
    )
    message, prompt, tools = process_selected_documents_contexts(
        test_db, [context], viewer.id, "question", "system", []
    )
    assert "permitted source" in message[0]["text"]
    assert prompt == "system"
    assert tools == []
    assert directory.call_count == 1


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("correlated", [False, True])
def test_bot_default_libraries_preserve_determined_rejection(
    test_db, permission_subject, reverse, correlated
):
    from fastapi import HTTPException

    from app.schemas.bot import BotUpdate
    from app.services.adapters.bot_kinds import BotKindsService

    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    parent = Namespace(name="bot-parent", owner_user_id=1, is_active=True)
    first = Namespace(name="bot-parent/child", owner_user_id=1, is_active=True)
    second = Namespace(name="bot-second", owner_user_id=1, is_active=True)
    test_db.add_all([parent, first, second])
    test_db.flush()
    bindings = [
        (first, "directory_group", "D0", "RestrictedAnalyst"),
        (parent, "user", str(viewer.id), "Reporter"),
    ]
    if correlated:
        bindings.append((second, "directory_group", "D0", "Reporter"))
    else:
        bindings.append((second, "user", str(viewer.id), "RestrictedAnalyst"))
    for group, kind, eid, role in bindings:
        test_db.add(
            ResourceMember(
                resource_type="Namespace",
                resource_id=group.id,
                entity_type=kind,
                entity_id=eid,
                role=role,
                status="approved",
            )
        )
    libraries = [test_db.get(Kind, ids[0]), test_db.get(Kind, ids[1])]
    for kb, group in zip(libraries, [first, second]):
        kb.namespace = group.name
        test_db.query(ResourceMember).filter_by(
            resource_type="KnowledgeBase", resource_id=kb.id
        ).delete()
    bot = Kind(
        kind="Bot",
        name="batch-bot",
        namespace="default",
        user_id=viewer.id,
        is_active=True,
        json={
            "metadata": {"name": "batch-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {"name": "batch-ghost", "namespace": "default"},
                "shellRef": {"name": "not-needed", "namespace": "default"},
            },
        },
    )
    ghost = Kind(
        kind="Ghost",
        name="batch-ghost",
        namespace="default",
        user_id=viewer.id,
        is_active=True,
        json={"spec": {"systemPrompt": "unchanged"}},
    )
    test_db.add_all([bot, ghost])
    test_db.flush()
    refs = [{"id": kb.id, "name": kb.json["spec"]["name"]} for kb in libraries]
    if reverse:
        refs.reverse()
    with pytest.raises(HTTPException) as failure:
        BotKindsService(Kind).update_with_user(
            test_db,
            bot_id=bot.id,
            obj_in=BotUpdate(default_knowledge_base_refs=refs),
            user_id=viewer.id,
        )
    assert failure.value.status_code == 400
    assert ghost.json["spec"] == {"systemPrompt": "unchanged"}
    assert directory.call_count == 1
