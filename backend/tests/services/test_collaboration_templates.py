"""Shared collaboration templates preserve the existing capability contracts."""

import json
from copy import deepcopy
from pathlib import Path

import pytest
import yaml
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.resource_library import ResourceLibraryCreateListingRequest
from app.services.resource_library_service import resource_library_service
from app.services.template_service import template_service


def create_template(db, user_id: int, name: str, namespace: str = "default") -> Kind:
    root = Path(__file__).resolve().parents[3]
    document = deepcopy(
        json.loads((root / "shared/data/collaboration-templates.json").read_text())[0]
    )
    document["metadata"] = {"name": name, "namespace": namespace}
    resource = Kind(
        user_id=user_id,
        kind="Template",
        name=name,
        namespace=namespace,
        json=document,
        is_active=True,
    )
    db.add(resource)
    db.commit()
    db.refresh(resource)
    return resource


def test_builtin_server_seeds_match_offline_definitions():
    root = Path(__file__).resolve().parents[3]
    canonical = json.loads(
        (root / "shared/data/collaboration-templates.json").read_text()
    )
    seeded = list(
        yaml.safe_load_all(
            (root / "backend/init_data/04-collaboration-templates.yaml").read_text()
        )
    )
    assert seeded == canonical


def test_inbox_api_cannot_list_read_or_instantiate_personal_templates(
    test_db, test_user
):
    personal = create_template(test_db, test_user.id, "same-name")
    official = create_template(test_db, 0, "official-collaboration", "system")
    assert template_service.list_templates(test_db).items == []
    for source in [personal, official]:
        with pytest.raises(HTTPException) as error:
            template_service.get_template(test_db, source.id)
        assert error.value.status_code == 404
        with pytest.raises(HTTPException) as error:
            template_service.instantiate_template(test_db, test_user.id, source.id)
        assert error.value.status_code == 404


def test_templates_publish_and_install_by_reference_without_copying_source(
    test_db, test_user
):
    consumer = User(
        user_name="template-consumer",
        email="consumer@example.test",
        password_hash="unused",
        is_active=True,
    )
    test_db.add(consumer)
    test_db.commit()
    source = create_template(test_db, test_user.id, "product-delivery")
    listing = resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="template",
            source_id=source.id,
            display_name="Product delivery",
            version=source.json["spec"]["version"],
        ),
        current_user=test_user,
    )
    assert listing.resource_type == "template"
    first = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=consumer,
    )
    second = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=consumer,
    )
    assert first.id == second.id
    assert first.listing_id == source.id
    assert test_db.query(Kind).filter(Kind.kind == "Template").count() == 1
    reference = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Template",
            ResourceMember.resource_id == source.id,
            ResourceMember.entity_id == str(consumer.id),
        )
        .one()
    )
    assert reference.status == "approved"


def test_inbox_templates_cannot_be_published_as_collaboration(test_db, test_user):
    source = create_template(test_db, test_user.id, "inbox-template")
    source.json = {**source.json, "spec": {**source.json["spec"], "category": "inbox"}}
    test_db.commit()
    with pytest.raises(HTTPException) as error:
        resource_library_service.publish(
            test_db,
            request=ResourceLibraryCreateListingRequest(
                resource_type="template",
                source_id=source.id,
                display_name="Inbox",
                version=source.json["spec"]["version"],
            ),
            current_user=test_user,
        )
    assert error.value.status_code == 404


def test_other_owner_cannot_publish_private_template(test_db, test_user):
    source = create_template(test_db, test_user.id + 100, "private-template")
    with pytest.raises(HTTPException) as error:
        resource_library_service.publish(
            test_db,
            request=ResourceLibraryCreateListingRequest(
                resource_type="template",
                source_id=source.id,
                display_name="Private",
                version=source.json["spec"]["version"],
            ),
            current_user=test_user,
        )
    assert error.value.status_code == 403
