"""Manual index grants retain caller identity and current document permissions."""

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.rag.runtime_resolver import RagRuntimeResolver
from app.services.share import knowledge_share_service
from tests.utils.retrieval_resources import embedding_model_kind, retriever_kind


@pytest.mark.parametrize("revocation", [None, "membership", "inactive"])
def test_manual_index_uses_owner_resources_and_current_caller_permission(
    test_db, test_user, revocation
):
    caller = User(
        user_name="manual-index-caller", password_hash="unused", is_active=True
    )
    kb = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="manual-grant",
        namespace="default",
        is_active=True,
        json={"spec": {"name": "manual-grant"}},
    )
    test_db.add_all(
        [
            caller,
            kb,
            retriever_kind(test_user.id, "owner-storage"),
            embedding_model_kind(test_user.id, "owner-embedding"),
        ]
    )
    test_db.commit()
    document = KnowledgeDocument(
        kind_id=kb.id,
        user_id=caller.id,
        attachment_id=1,
        name="manual.md",
        file_extension="md",
        file_size=8,
        source_type="file",
    )
    test_db.add(document)
    test_db.commit()
    member = knowledge_share_service.add_member(
        test_db,
        resource_id=kb.id,
        current_user_id=test_user.id,
        target_user_id=caller.id,
        role=BaseRole.Maintainer,
    )
    if revocation == "membership":
        row = test_db.get(ResourceMember, member.id)
        test_db.delete(row)
    elif revocation == "inactive":
        caller.is_active = False
    test_db.commit()

    def authorize():
        return RagRuntimeResolver().build_index_runtime_spec(
            db=test_db,
            knowledge_base_id=str(kb.id),
            attachment_id=1,
            retriever_name="owner-storage",
            retriever_namespace="default",
            embedding_model_name="owner-embedding",
            embedding_model_namespace="default",
            user_id=test_user.id,
            user_name=caller.user_name,
            document_id=document.id,
            splitter_config_dict=None,
            caller_user_id=caller.id,
        )

    if revocation:
        with pytest.raises(HTTPException) as error:
            authorize()
        assert error.value.status_code == 403
    else:
        grant = authorize()
        assert grant.caller_user_id == caller.id
        assert grant.index_owner_user_id == test_user.id
        assert grant.authorized_resources.operation == "index"
