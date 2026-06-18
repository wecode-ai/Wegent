# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.user import User
from app.schemas.namespace import GroupLevel, GroupVisibility
from app.schemas.resource_library import ResourceLibraryListingCreate
from app.services.resource_library.discovery import (
    DISCOVERY_CONFIG_KIND,
    DISCOVERY_CONFIG_NAME,
    DISCOVERY_CONFIG_NAMESPACE,
    resource_library_discovery_service,
)
from app.services.resource_library.service import resource_library_service


def create_user(test_db, name: str) -> User:
    user = User(
        user_name=name,
        password_hash=get_password_hash("password123"),
        email=f"{name}@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def create_team(test_db, *, user_id: int, name: str, description: str) -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {
                "name": name,
                "namespace": "default",
                "description": description,
            },
            "spec": {"members": [], "collaborationModel": "solo"},
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def create_org_knowledge_base(test_db, owner: User, *, name: str = "资源库") -> Kind:
    namespace = Namespace(
        name="company",
        display_name="Company",
        owner_user_id=owner.id,
        visibility=GroupVisibility.internal.value,
        description="Company workspace",
        level=GroupLevel.organization.value,
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()

    kb = Kind(
        user_id=owner.id,
        kind="KnowledgeBase",
        name="kb-company-resource-library",
        namespace=namespace.name,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {"name": "resource-library", "namespace": namespace.name},
            "spec": {
                "name": name,
                "description": "Resource Library discovery index",
                "kbType": "classic",
                "retrievalConfig": {
                    "retriever_name": "test-retriever",
                    "embedding_config": {"model_name": "embed"},
                },
            },
        },
        is_active=True,
    )
    test_db.add(kb)
    test_db.commit()
    test_db.refresh(kb)
    return kb


def create_discovery_config(test_db, *, kb: Kind) -> Kind:
    config = Kind(
        user_id=0,
        kind=DISCOVERY_CONFIG_KIND,
        name=DISCOVERY_CONFIG_NAME,
        namespace=DISCOVERY_CONFIG_NAMESPACE,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": DISCOVERY_CONFIG_KIND,
            "metadata": {
                "name": DISCOVERY_CONFIG_NAME,
                "namespace": DISCOVERY_CONFIG_NAMESPACE,
            },
            "spec": {
                "knowledgeBaseRef": {
                    "id": kb.id,
                    "name": "资源库",
                    "namespace": kb.namespace,
                },
                "assistantTeamRef": {
                    "name": "resource-discovery-assistant",
                    "namespace": "default",
                },
            },
        },
        is_active=True,
    )
    test_db.add(config)
    test_db.commit()
    test_db.refresh(config)
    return config


def test_discovery_config_kind_points_to_organization_knowledge_base(
    test_db, test_user
):
    kb = create_org_knowledge_base(test_db, test_user)
    create_discovery_config(test_db, kb=kb)

    config = resource_library_discovery_service.get_page_config(test_db)

    assert config["knowledge_base_ref"]["id"] == kb.id
    assert config["knowledge_base_ref"]["namespace"] == "company"
    assert config["assistant_team_ref"] == {
        "name": "resource-discovery-assistant",
        "namespace": "default",
    }


def test_create_listing_syncs_visible_document_to_configured_knowledge_base(
    monkeypatch, test_db, test_user
):
    kb_owner = create_user(test_db, "kb-owner")
    kb = create_org_knowledge_base(test_db, kb_owner)
    create_discovery_config(test_db, kb=kb)
    source_team = create_team(
        test_db,
        user_id=test_user.id,
        name="research-agent",
        description="Finds market research signals",
    )
    created_documents = []

    def fake_create_document_with_content(**kwargs):
        created_documents.append(kwargs)
        return type("CreatedDocument", (), {"id": 123})()

    monkeypatch.setattr(
        "app.services.resource_library.discovery.knowledge_orchestrator.create_document_with_content",
        fake_create_document_with_content,
    )

    listing = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=ResourceLibraryListingCreate(
            resource_type="agent",
            source_id=source_team.id,
            name="research-agent",
            display_name="Research Agent",
            description="Finds market research signals",
            tags=["research"],
            version="1.0.0",
        ),
    )

    assert created_documents[0]["knowledge_base_id"] == kb.id
    assert created_documents[0]["user"].id == kb_owner.id
    assert "Listing ID: " + str(listing.id) in created_documents[0]["content"]
    assert "Resource type: agent" in created_documents[0]["content"]
