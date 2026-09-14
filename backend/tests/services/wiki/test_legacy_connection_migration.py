# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime

import pytest

from app.models.kind import Kind
from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.services.external_source_connections import external_source_connection_service
from app.services.wiki.legacy_connection_migration import (
    inspect_legacy_wiki_connections,
    migrate_legacy_wiki_connections,
)
from app.services.wiki.service import WikiConnectionService
from shared.utils.crypto import encrypt_sensitive_data


def _set_legacy_preferences(test_db, user) -> None:
    user.preferences = json.dumps(
        {
            "theme": "dark",
            "mcps": {
                "wiki": {
                    "services": {
                        "site": {
                            "enabled": True,
                            "connector": "wikijs",
                            "credentials": {
                                "url": encrypt_sensitive_data(
                                    "https://legacy-wiki.example.com"
                                ),
                                "api_key": encrypt_sensitive_data("legacy-secret"),
                            },
                            "options": {"default_locale": "zh"},
                        }
                    }
                }
            },
        }
    )
    test_db.commit()


def _create_wiki_document(test_db, user, page_id: str) -> KnowledgeDocument:
    knowledge_base = Kind(
        user_id=user.id,
        kind="KnowledgeBase",
        name=f"legacy-wiki-kb-{page_id}",
        namespace="default",
        json={"spec": {"name": f"KB {page_id}"}},
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    test_db.add(knowledge_base)
    test_db.flush()
    document = KnowledgeDocument(
        kind_id=knowledge_base.id,
        attachment_id=99,
        name=f"Page {page_id}",
        file_extension="md",
        file_size=123,
        user_id=user.id,
        is_active=True,
        status="enabled",
        source_type="external",
        index_status=DocumentIndexStatus.SUCCESS,
        source_config={
            "external": {
                "provider": "wiki",
                "sync": {
                    "enabled": True,
                    "connection_id": "legacy-default",
                    "resource_id": page_id,
                    "indexed_version": "v1",
                },
            }
        },
        external_source=KnowledgeDocumentExternalSource(
            kind_id=knowledge_base.id,
            external_provider="wiki",
            external_resource_id=f"v1:legacy-default:{page_id}",
        ),
    )
    test_db.add(document)
    test_db.commit()
    test_db.refresh(document)
    return document


def test_migrates_legacy_config_as_second_named_connection(test_db, test_user):
    external_source_connection_service.save_owned(
        test_db,
        owner_user_id=test_user.id,
        provider_id="wiki",
        connection_id="conn-primary",
        display_name="twiki",
        adapter_type="wikijs",
        enabled=True,
        config={"site_url": "https://twiki.example.com"},
        credentials={"api_key": "twiki-secret"},
        create_if_missing=True,
    )
    _set_legacy_preferences(test_db, test_user)
    document = _create_wiki_document(test_db, test_user, "42")

    preview = inspect_legacy_wiki_connections(test_db)
    assert preview.connection_count == 1
    assert preview.document_count == 1
    assert preview.issues == []

    report = migrate_legacy_wiki_connections(test_db)

    assert report.applied is True
    assert report.connection_count == 1
    assert report.document_count == 1
    assert [
        item["display_name"]
        for item in WikiConnectionService.list_connections(test_db, test_user)
    ] == ["twiki", "默认 Wiki"]
    migrated = external_source_connection_service.get_owned(
        test_db,
        owner_user_id=test_user.id,
        provider_id="wiki",
        connection_id=f"legacy-{test_user.id}",
    )
    assert migrated is not None
    assert migrated.config == {
        "site_url": "https://legacy-wiki.example.com",
        "default_locale": "zh",
    }
    assert migrated.credentials["api_key"] == "legacy-secret"

    test_db.refresh(test_user)
    preferences = json.loads(test_user.preferences)
    assert preferences == {"theme": "dark"}
    test_db.refresh(document)
    assert document.external_resource_id == f"v1:legacy-{test_user.id}:42"
    assert document.external_source_config["sync"]["connection_id"] == (
        f"legacy-{test_user.id}"
    )
    assert document.external_source_config["sync"]["site_url"] == (
        "https://legacy-wiki.example.com"
    )
    assert document.attachment_id == 99
    assert document.index_status == DocumentIndexStatus.SUCCESS

    repeated = migrate_legacy_wiki_connections(test_db)
    assert repeated.applied is False
    assert repeated.connection_count == 0
    assert repeated.document_count == 0


def test_migration_refuses_external_identity_collision(test_db, test_user):
    _set_legacy_preferences(test_db, test_user)
    old_document = _create_wiki_document(test_db, test_user, "42")
    conflicting = _create_wiki_document(test_db, test_user, "42-conflict")
    conflicting.kind_id = old_document.kind_id
    conflicting.external_source.kind_id = old_document.kind_id
    conflicting.external_source.external_resource_id = f"v1:legacy-{test_user.id}:42"
    test_db.commit()

    preview = inspect_legacy_wiki_connections(test_db)
    assert preview.issues

    with pytest.raises(RuntimeError, match="identity collision"):
        migrate_legacy_wiki_connections(test_db)

    assert (
        external_source_connection_service.get_owned(
            test_db,
            owner_user_id=test_user.id,
            provider_id="wiki",
            connection_id=f"legacy-{test_user.id}",
        )
        is None
    )
    test_db.refresh(test_user)
    assert "wiki" in json.loads(test_user.preferences)["mcps"]
    test_db.refresh(old_document)
    assert old_document.external_resource_id == "v1:legacy-default:42"
