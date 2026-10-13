# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public Skill download API-key coverage for the Python-owned route."""

from typing import Tuple

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.api_key import APIKey


@pytest.fixture(scope="function")
def test_public_skill_setup(test_db: Session):
    """Create a test public skill for download testing."""
    import hashlib
    import io
    import zipfile

    from app.models.kind import Kind
    from app.models.skill_binary import SkillBinary

    # Create public skill kind (user_id=0)
    skill_json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Skill",
        "metadata": {
            "name": "test-public-skill",
            "namespace": "default",
            "labels": {"id": "2", "user_id": "0"},
        },
        "spec": {
            "description": "Test public skill for API key auth testing",
            "prompt": "Test prompt",
            "version": "1.0.0",
            "author": "Test",
            "tags": [],
            "bindShells": [],
        },
    }

    skill_kind = Kind(
        user_id=0,  # Public skill
        name="test-public-skill",
        namespace="default",
        kind="Skill",
        json=skill_json,
        is_active=True,
    )
    test_db.add(skill_kind)
    test_db.commit()
    test_db.refresh(skill_kind)

    # Create a minimal valid ZIP with SKILL.md
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("test-public-skill/SKILL.md", "# Test Public Skill\nTest content")
    zip_content = zip_buffer.getvalue()

    # Calculate hash
    file_hash = hashlib.sha256(zip_content).hexdigest()

    # Create binary for the skill
    skill_binary = SkillBinary(
        kind_id=skill_kind.id,
        binary_data=zip_content,
        file_size=len(zip_content),
        file_hash=file_hash,
    )
    test_db.add(skill_binary)
    test_db.commit()

    return skill_kind


@pytest.mark.integration
def test_download_public_skill_with_api_key(
    test_client: TestClient,
    test_api_key: Tuple[str, APIKey],
    test_public_skill_setup,
):
    """Test downloading public skill using API key"""
    raw_key, api_key_record = test_api_key
    skill = test_public_skill_setup

    response = test_client.get(
        f"/api/v1/kinds/skills/public/{skill.id}/download",
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
