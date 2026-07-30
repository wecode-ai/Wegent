# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for internal Skill binary download authentication."""

import hashlib

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.skill_binary import SkillBinary


@pytest.fixture(autouse=True)
def configure_internal_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


@pytest.fixture
def public_skill(test_db: Session) -> Kind:
    binary_data = b"public-skill-binary"
    skill = Kind(
        user_id=0,
        name="public-skill",
        namespace="default",
        kind="Skill",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": "public-skill", "namespace": "default"},
            "spec": {},
        },
        is_active=True,
    )
    test_db.add(skill)
    test_db.flush()
    test_db.add(
        SkillBinary(
            kind_id=skill.id,
            binary_data=binary_data,
            file_size=len(binary_data),
            file_hash=hashlib.sha256(binary_data).hexdigest(),
        )
    )
    test_db.commit()
    test_db.refresh(skill)
    return skill


def test_download_rejects_missing_token(
    test_client: TestClient,
    public_skill: Kind,
) -> None:
    response = test_client.get(f"/api/internal/skills/{public_skill.id}/binary")

    assert response.status_code == 401


def test_download_rejects_invalid_token(
    test_client: TestClient,
    public_skill: Kind,
) -> None:
    response = test_client.get(
        f"/api/internal/skills/{public_skill.id}/binary",
        headers={"Authorization": "Bearer invalid-token"},
    )

    assert response.status_code == 401


def test_download_accepts_internal_service_token(
    test_client: TestClient,
    public_skill: Kind,
) -> None:
    response = test_client.get(
        f"/api/internal/skills/{public_skill.id}/binary",
        headers={"Authorization": "Bearer test-internal-token"},
    )

    assert response.status_code == 200
    assert response.content == b"public-skill-binary"
    assert response.headers["content-type"] == "application/zip"
