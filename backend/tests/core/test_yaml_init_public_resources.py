# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for public resource YAML initialization."""

from sqlalchemy.orm import Session

from app.core.yaml_init import apply_public_resources
from app.models.kind import Kind


def _video_model_resource() -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Model",
        "metadata": {
            "name": "seedance-2-0-pro",
            "namespace": "default",
            "displayName": "Seedance 2.0 Pro",
        },
        "spec": {
            "protocol": "seedance",
            "modelType": "video",
            "modelConfig": {
                "env": {
                    "model": "seedance",
                    "model_id": "doubao-seedance-2-0-260128",
                }
            },
        },
    }


def test_apply_public_resources_creates_public_video_model(
    test_db: Session,
) -> None:
    resource = _video_model_resource()

    results = apply_public_resources(test_db, [resource])

    assert results == [
        {
            "kind": "Model",
            "name": "seedance-2-0-pro",
            "namespace": "default",
            "operation": "created",
            "success": True,
        }
    ]
    stored = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Model",
            Kind.namespace == "default",
            Kind.name == "seedance-2-0-pro",
        )
        .one()
    )
    assert stored.json == resource
    assert stored.is_active is True


def test_apply_public_resources_skips_existing_public_video_model(
    test_db: Session,
) -> None:
    resource = _video_model_resource()
    apply_public_resources(test_db, [resource])

    results = apply_public_resources(test_db, [resource])

    assert results == [
        {
            "kind": "Model",
            "name": "seedance-2-0-pro",
            "namespace": "default",
            "operation": "skipped",
            "success": True,
            "reason": "already_exists",
        }
    ]
