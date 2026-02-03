# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Integration tests for Executor API Key authentication.

Tests the API Key authentication flow for executor-related endpoints:
- Skill download endpoints
- Attachment executor-download endpoint
- Backward compatibility with JWT Token
"""

import hashlib
from datetime import datetime, timedelta
from typing import Tuple

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.api_key import KEY_TYPE_PERSONAL, KEY_TYPE_SERVICE, APIKey
from app.models.user import User


@pytest.fixture(scope="function")
def test_skill_setup(test_db: Session, test_user: User):
    """Create a test skill for download testing."""
    import hashlib
    import io
    import zipfile

    from app.models.kind import Kind
    from app.models.skill_binary import SkillBinary

    # Create skill kind
    skill_json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Skill",
        "metadata": {
            "name": "test-skill",
            "namespace": "default",
            "labels": {"id": "1", "user_id": str(test_user.id)},
        },
        "spec": {
            "description": "Test skill for API key auth testing",
            "prompt": "Test prompt",
            "version": "1.0.0",
            "author": "Test",
            "tags": [],
            "bindShells": [],
        },
    }

    skill_kind = Kind(
        user_id=test_user.id,
        name="test-skill",
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
        zf.writestr("test-skill/SKILL.md", "# Test Skill\nTest content")
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
class TestSkillDownloadWithApiKey:
    """Test skill download endpoints with API Key authentication"""

    def test_download_skill_with_api_key_header(
        self,
        test_client: TestClient,
        test_api_key: Tuple[str, APIKey],
        test_skill_setup,
    ):
        """Test downloading skill using X-API-Key header"""
        raw_key, api_key_record = test_api_key
        skill = test_skill_setup

        response = test_client.get(
            f"/api/v1/kinds/skills/{skill.id}/download",
            headers={"X-API-Key": raw_key},
        )

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"

    def test_download_skill_with_bearer_api_key(
        self,
        test_client: TestClient,
        test_api_key: Tuple[str, APIKey],
        test_skill_setup,
    ):
        """Test downloading skill using Bearer token with API key"""
        raw_key, api_key_record = test_api_key
        skill = test_skill_setup

        response = test_client.get(
            f"/api/v1/kinds/skills/{skill.id}/download",
            headers={"Authorization": f"Bearer {raw_key}"},
        )

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"

    def test_download_skill_with_jwt_token(
        self,
        test_client: TestClient,
        test_token: str,
        test_skill_setup,
    ):
        """Test downloading skill using JWT token (backward compatibility)"""
        skill = test_skill_setup

        response = test_client.get(
            f"/api/v1/kinds/skills/{skill.id}/download",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"

    def test_download_skill_with_invalid_api_key(
        self,
        test_client: TestClient,
        test_skill_setup,
    ):
        """Test downloading skill with invalid API key fails"""
        skill = test_skill_setup

        response = test_client.get(
            f"/api/v1/kinds/skills/{skill.id}/download",
            headers={"X-API-Key": "wg-invalid-key-12345"},
        )

        assert response.status_code == 401

    def test_download_skill_without_auth(
        self,
        test_client: TestClient,
        test_skill_setup,
    ):
        """Test downloading skill without authentication fails"""
        skill = test_skill_setup

        response = test_client.get(
            f"/api/v1/kinds/skills/{skill.id}/download",
        )

        assert response.status_code == 401

    def test_download_public_skill_with_api_key(
        self,
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


@pytest.mark.integration
class TestSkillDownloadWithServiceKey:
    """Test that service keys are rejected for skill download"""

    def test_download_skill_with_service_key_rejected(
        self,
        test_client: TestClient,
        test_db: Session,
        test_user: User,
        test_skill_setup,
    ):
        """Test that service keys are rejected for skill download"""
        # Create a service API key
        raw_key = "wg-service-key-for-test"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        service_key = APIKey(
            user_id=test_user.id,
            key_hash=key_hash,
            key_prefix="wg-service...",
            name="Service Key",
            key_type=KEY_TYPE_SERVICE,
            description="Service key for testing",
            expires_at=datetime.utcnow() + timedelta(days=365),
            is_active=True,
        )
        test_db.add(service_key)
        test_db.commit()

        skill = test_skill_setup

        response = test_client.get(
            f"/api/v1/kinds/skills/{skill.id}/download",
            headers={"X-API-Key": raw_key},
        )

        assert response.status_code == 401


@pytest.mark.integration
class TestApiKeyPriority:
    """Test authentication priority when multiple auth methods provided"""

    def test_api_key_header_takes_priority(
        self,
        test_client: TestClient,
        test_api_key: Tuple[str, APIKey],
        test_skill_setup,
    ):
        """Test that X-API-Key header takes priority over Authorization header"""
        raw_key, api_key_record = test_api_key
        skill = test_skill_setup

        # Provide both X-API-Key and invalid JWT in Authorization
        response = test_client.get(
            f"/api/v1/kinds/skills/{skill.id}/download",
            headers={
                "X-API-Key": raw_key,
                "Authorization": "Bearer invalid-jwt-token",
            },
        )

        # Should succeed because X-API-Key takes priority
        assert response.status_code == 200

    def test_jwt_used_when_no_api_key_header(
        self,
        test_client: TestClient,
        test_token: str,
        test_skill_setup,
    ):
        """Test that JWT is used when X-API-Key header is not provided"""
        skill = test_skill_setup

        response = test_client.get(
            f"/api/v1/kinds/skills/{skill.id}/download",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200


@pytest.mark.integration
class TestExpiredAndInactiveApiKeys:
    """Test handling of expired and inactive API keys"""

    def test_download_skill_with_expired_api_key(
        self,
        test_client: TestClient,
        test_db: Session,
        test_user: User,
        test_skill_setup,
    ):
        """Test downloading skill with expired API key fails"""
        # Create an expired API key
        raw_key = "wg-expired-key-for-test"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        expired_key = APIKey(
            user_id=test_user.id,
            key_hash=key_hash,
            key_prefix="wg-expired...",
            name="Expired Key",
            key_type=KEY_TYPE_PERSONAL,
            description="Expired key for testing",
            expires_at=datetime.utcnow() - timedelta(days=1),  # Expired
            is_active=True,
        )
        test_db.add(expired_key)
        test_db.commit()

        skill = test_skill_setup

        response = test_client.get(
            f"/api/v1/kinds/skills/{skill.id}/download",
            headers={"X-API-Key": raw_key},
        )

        assert response.status_code == 401

    def test_download_skill_with_inactive_api_key(
        self,
        test_client: TestClient,
        test_db: Session,
        test_user: User,
        test_skill_setup,
    ):
        """Test downloading skill with inactive API key fails"""
        # Create an inactive API key
        raw_key = "wg-inactive-key-for-test"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        inactive_key = APIKey(
            user_id=test_user.id,
            key_hash=key_hash,
            key_prefix="wg-inactive...",
            name="Inactive Key",
            key_type=KEY_TYPE_PERSONAL,
            description="Inactive key for testing",
            expires_at=datetime.utcnow() + timedelta(days=365),
            is_active=False,  # Inactive
        )
        test_db.add(inactive_key)
        test_db.commit()

        skill = test_skill_setup

        response = test_client.get(
            f"/api/v1/kinds/skills/{skill.id}/download",
            headers={"X-API-Key": raw_key},
        )

        assert response.status_code == 401
