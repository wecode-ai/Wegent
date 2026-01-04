# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API integration tests for Skills endpoints
"""
import io
import zipfile

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User


@pytest.mark.api
class TestSkillsAPI:
    """Test Skills API endpoints"""

    @staticmethod
    def create_test_zip(skill_md_content: str, folder_name: str = "test") -> bytes:
        """Create a test ZIP with SKILL.md in a skill folder"""
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(f"{folder_name}/SKILL.md", skill_md_content)
            zf.writestr(f"{folder_name}/script.py", "print('test')")
        return zip_buffer.getvalue()

    def test_upload_skill_success(self, test_client: TestClient, test_token: str):
        """Test successful skill upload"""
        skill_md = """---
description: "API test skill"
version: "1.0.0"
author: "API Tester"
tags: ["api", "test"]
---

"""
        zip_content = self.create_test_zip(skill_md)

        response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "api-test-skill", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["metadata"]["name"] == "api-test-skill"
        assert data["spec"]["description"] == "API test skill"
        assert data["spec"]["version"] == "1.0.0"
        assert data["status"]["state"] == "Available"

    def test_upload_skill_without_auth(self, test_client: TestClient):
        """Test upload fails without authentication"""
        skill_md = "---\ndescription: Test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        response = test_client.post(
            "/api/v1/kinds/skills/upload",
            data={"name": "unauth-skill", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )

        assert response.status_code == 401

    def test_upload_skill_non_zip_file(self, test_client: TestClient, test_token: str):
        """Test upload fails with non-ZIP file"""
        response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "invalid-file", "namespace": "default"},
            files={"file": ("test.txt", io.BytesIO(b"not a zip"), "text/plain")},
        )

        assert response.status_code == 400
        assert "ZIP package" in response.json()["detail"]

    def test_upload_skill_missing_skill_md(
        self, test_client: TestClient, test_token: str
    ):
        """Test upload fails when SKILL.md is missing"""
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w") as zf:
            zf.writestr("test/README.md", "No SKILL.md here")

        response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "no-skill-md", "namespace": "default"},
            files={
                "file": (
                    "test.zip",
                    io.BytesIO(zip_buffer.getvalue()),
                    "application/zip",
                )
            },
        )

        assert response.status_code == 400
        assert "SKILL.md not found" in response.json()["detail"]

    def test_upload_skill_duplicate_name(
        self, test_client: TestClient, test_token: str
    ):
        """Test upload fails with duplicate skill name"""
        skill_md = "---\ndescription: Duplicate test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Upload first skill
        first_response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "duplicate-name", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert first_response.status_code == 201

        # Upload second skill with same name
        response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "duplicate-name", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )

        assert response.status_code == 400
        assert "already exists" in response.json()["detail"]

    def test_list_skills(self, test_client: TestClient, test_token: str):
        """Test listing skills"""
        skill_md = "---\ndescription: List API test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create 2 skills
        for i in range(2):
            response = test_client.post(
                "/api/v1/kinds/skills/upload",
                headers={"Authorization": f"Bearer {test_token}"},
                data={"name": f"list-api-test-{i}", "namespace": "default"},
                files={
                    "file": ("test.zip", io.BytesIO(zip_content), "application/zip")
                },
            )
            assert response.status_code == 201

        # List skills
        response = test_client.get(
            "/api/v1/kinds/skills", headers={"Authorization": f"Bearer {test_token}"}
        )

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert len(data["items"]) >= 2

    def test_list_skills_by_name(self, test_client: TestClient, test_token: str):
        """Test querying skill by name"""
        skill_md = "---\ndescription: Query by name test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create skill
        create_response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "query-by-name", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert create_response.status_code == 201

        # Query by name
        response = test_client.get(
            "/api/v1/kinds/skills?name=query-by-name",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 1
        assert data["items"][0]["metadata"]["name"] == "query-by-name"

    def test_get_skill_by_id(self, test_client: TestClient, test_token: str):
        """Test getting skill by ID"""
        skill_md = "---\ndescription: Get by ID API test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create skill
        create_response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "get-by-id-api", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["metadata"]["labels"]["id"]

        # Get by ID
        response = test_client.get(
            f"/api/v1/kinds/skills/{skill_id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["metadata"]["name"] == "get-by-id-api"

    def test_get_skill_not_found(self, test_client: TestClient, test_token: str):
        """Test getting non-existent skill returns 404"""
        response = test_client.get(
            "/api/v1/kinds/skills/99999",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 404

    def test_download_skill(self, test_client: TestClient, test_token: str):
        """Test downloading skill ZIP"""
        skill_md = "---\ndescription: Download test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create skill
        create_response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "download-test", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["metadata"]["labels"]["id"]

        # Download skill
        response = test_client.get(
            f"/api/v1/kinds/skills/{skill_id}/download",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        assert "Content-Disposition" in response.headers
        assert "download-test.zip" in response.headers["Content-Disposition"]

        # Verify ZIP is valid
        downloaded_zip = zipfile.ZipFile(io.BytesIO(response.content))
        assert "test/SKILL.md" in downloaded_zip.namelist()

    def test_update_skill(self, test_client: TestClient, test_token: str):
        """Test updating skill with new ZIP"""
        original_md = "---\ndescription: Original\nversion: '1.0.0'\n---\n"
        original_zip = self.create_test_zip(original_md, "update-api-test")

        # Create skill
        create_response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "update-api-test", "namespace": "default"},
            files={
                "file": (
                    "update-api-test.zip",
                    io.BytesIO(original_zip),
                    "application/zip",
                )
            },
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["metadata"]["labels"]["id"]

        # Update skill
        updated_md = "---\ndescription: Updated\nversion: '2.0.0'\n---\n"
        updated_zip = self.create_test_zip(updated_md, "update-api-test")

        response = test_client.put(
            f"/api/v1/kinds/skills/{skill_id}",
            headers={"Authorization": f"Bearer {test_token}"},
            files={
                "file": (
                    "update-api-test.zip",
                    io.BytesIO(updated_zip),
                    "application/zip",
                )
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["spec"]["description"] == "Updated"
        assert data["spec"]["version"] == "2.0.0"

    def test_update_skill_not_found(self, test_client: TestClient, test_token: str):
        """Test updating non-existent skill returns 404"""
        skill_md = "---\ndescription: Test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        response = test_client.put(
            "/api/v1/kinds/skills/99999",
            headers={"Authorization": f"Bearer {test_token}"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )

        assert response.status_code == 404

    def test_delete_skill(self, test_client: TestClient, test_token: str):
        """Test deleting skill"""
        skill_md = "---\ndescription: Delete API test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create skill
        create_response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "delete-api-test", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["metadata"]["labels"]["id"]

        # Delete skill
        response = test_client.delete(
            f"/api/v1/kinds/skills/{skill_id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 204

        # Verify skill is deleted
        get_response = test_client.get(
            f"/api/v1/kinds/skills/{skill_id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )
        assert get_response.status_code == 404

    def test_delete_skill_referenced_by_ghost(
        self,
        test_client: TestClient,
        test_token: str,
        test_db: Session,
        test_user: User,
    ):
        """Test deleting skill fails when referenced by Ghost"""
        skill_md = "---\ndescription: Referenced skill\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create skill
        create_response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "referenced-api-skill", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["metadata"]["labels"]["id"]

        # Create Ghost that references this skill
        ghost_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "api-test-ghost", "namespace": "default"},
            "spec": {"systemPrompt": "Test", "skills": ["referenced-api-skill"]},
        }

        ghost_kind = Kind(
            user_id=test_user.id,
            kind="Ghost",
            name="api-test-ghost",
            namespace="default",
            json=ghost_json,
            is_active=True,
        )
        test_db.add(ghost_kind)
        test_db.commit()

        # Try to delete skill
        response = test_client.delete(
            f"/api/v1/kinds/skills/{skill_id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 400
        # detail is now a dict with structured error info
        detail = response.json()["detail"]
        assert detail["code"] == "SKILL_REFERENCED"
        assert "referenced by Ghosts" in detail["message"]
        assert any(g["name"] == "api-test-ghost" for g in detail["referenced_ghosts"])

    def test_delete_skill_not_found(self, test_client: TestClient, test_token: str):
        """Test deleting non-existent skill returns 404"""
        response = test_client.delete(
            "/api/v1/kinds/skills/99999",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 404

    def test_user_isolation(
        self, test_client: TestClient, test_token: str, test_admin_token: str
    ):
        """Test users cannot access each other's skills"""
        skill_md = "---\ndescription: User isolation test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # User 1 creates skill
        create_response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "user1-skill", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["metadata"]["labels"]["id"]

        # User 2 tries to access User 1's skill
        response = test_client.get(
            f"/api/v1/kinds/skills/{skill_id}",
            headers={"Authorization": f"Bearer {test_admin_token}"},
        )

        assert response.status_code == 404

        # User 2 tries to delete User 1's skill
        delete_response = test_client.delete(
            f"/api/v1/kinds/skills/{skill_id}",
            headers={"Authorization": f"Bearer {test_admin_token}"},
        )

        assert delete_response.status_code == 404


@pytest.mark.api
class TestPublicSkillUploadAPI:
    """Test Public Skills Upload API endpoints"""

    @staticmethod
    def create_test_zip(skill_md_content: str, folder_name: str = "test") -> bytes:
        """Create a test  SKILL.md in a skill folder"""
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(f"{folder_name}/SKILL.md", skill_md_content)
            zf.writestr(f"{folder_name}/script.py", "print('test')")
        return zip_buffer.getvalue()

    def test_upload_public_skill_success(
        self, test_client: TestClient, test_admin_token: str
    ):
        """Test successful public skill upload by admin"""
        skill_md = """---
description: "Public API test skill"
version: "1.0.0"
author: "Admin Tester"
tags: ["public", "api", "test"]
---

"""
        zip_content = self.create_test_zip(skill_md)

        response = test_client.post(
            "/api/v1/kinds/skills/public/upload",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            data={"name": "public-api-test-skill"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "public-api-test-skill"
        assert data["description"] == "Public API test skill"
        assert data["version"] == "1.0.0"
        assert data["is_public"] is True

    def test_upload_public_skill_non_admin_forbidden(
        self, test_client: TestClient, test_token: str
    ):
        """Test non-admin user cannot upload public skill"""
        skill_md = "---\ndescription: Test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        response = test_client.post(
            "/api/v1/kinds/skills/public/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "non-admin-public-skill"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )

        assert response.status_code == 403

    def test_upload_public_skill_without_auth(self, test_client: TestClient):
        """Test upload fails without authentication"""
        skill_md = "---\ndescription: Test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        response = test_client.post(
            "/api/v1/kinds/skills/public/upload",
            data={"name": "unauth-public-skill"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )

        assert response.status_code == 401

    def test_upload_public_skill_non_zip_file(
        self, test_client: TestClient, test_admin_token: str
    ):
        """Test upload fails with non-ZIP file"""
        response = test_client.post(
            "/api/v1/kinds/skills/public/upload",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            data={"name": "invalid-public-file"},
            files={"file": ("test.txt", io.BytesIO(b"not a zip"), "text/plain")},
        )

        assert response.status_code == 400
        assert "ZIP package" in response.json()["detail"]

    def test_upload_public_skill_duplicate_name(
        self, test_client: TestClient, test_admin_token: str
    ):
        """Test upload fails with duplicate public skill name"""
        skill_md = "---\ndescription: Duplicate public test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Upload first public skill
        first_response = test_client.post(
            "/api/v1/kinds/skills/public/upload",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            data={"name": "duplicate-public-name"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert first_response.status_code == 201

        # Upload second public skill with same name
        response = test_client.post(
            "/api/v1/kinds/skills/public/upload",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            data={"name": "duplicate-public-name"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )

        assert response.status_code == 400
        assert "already exists" in response.json()["detail"]

    def test_update_public_skill_with_upload_success(
        self, test_client: TestClient, test_admin_token: str
    ):
        """Test successful public skill update with new ZIP"""
        original_md = "---\ndescription: Original public\nversion: '1.0.0'\n---\n"
        original_zip = self.create_test_zip(original_md, "update-public-test")

        # Create public skill
        create_response = test_client.post(
            "/api/v1/kinds/skills/public/upload",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            data={"name": "update-public-test"},
            files={
                "file": (
                    "update-public-test.zip",
                    io.BytesIO(original_zip),
                    "application/zip",
                )
            },
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["id"]

        # Update public skill
        updated_md = "---\ndescription: Updated public\nversion: '2.0.0'\n---\n"
        updated_zip = self.create_test_zip(updated_md, "update-public-test")

        response = test_client.put(
            f"/api/v1/kinds/skills/public/{skill_id}/upload",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            files={
                "file": (
                    "update-public-test.zip",
                    io.BytesIO(updated_zip),
                    "application/zip",
                )
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["description"] == "Updated public"
        assert data["version"] == "2.0.0"
        assert data["is_public"] is True

    def test_update_public_skill_non_admin_forbidden(
        self, test_client: TestClient, test_admin_token: str, test_token: str
    ):
        """Test non-admin user cannot update public skill"""
        skill_md = "---\ndescription: Test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create public skill as admin
        create_response = test_client.post(
            "/api/v1/kinds/skills/public/upload",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            data={"name": "non-admin-update-test"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["id"]

        # Try to update as non-admin
        response = test_client.put(
            f"/api/v1/kinds/skills/public/{skill_id}/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )

        assert response.status_code == 403

    def test_update_public_skill_not_found(
        self, test_client: TestClient, test_admin_token: str
    ):
        """Test updating non-existent public skill returns 404"""
        skill_md = "---\ndescription: Test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        response = test_client.put(
            "/api/v1/kinds/skills/public/99999/upload",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )

        assert response.status_code == 404

    def test_download_public_skill_success(
        self, test_client: TestClient, test_admin_token: str, test_token: str
    ):
        """Test downloading public skill r user"""
        skill_md = "---\ndescription: Download public test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create public skill as admin
        create_response = test_client.post(
            "/api/v1/kinds/skills/public/upload",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            data={"name": "download-public-test"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["id"]

        # Download as regular user
        response = test_client.get(
            f"/api/v1/kinds/skills/public/{skill_id}/download",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        assert "Content-Disposition" in response.headers
        assert "download-public-test.zip" in response.headers["Content-Disposition"]

        # Verify ZIP is valid
        downloaded_zip = zipfile.ZipFile(io.BytesIO(response.content))
        assert "test/SKILL.md" in downloaded_zip.namelist()

    def test_download_public_skill_without_auth(
        self, test_client: TestClient, test_admin_token: str
    ):
        """Test download fails without authentication"""
        skill_md = "---\ndescription: Test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create public skill as admin
        create_response = test_client.post(
            "/api/v1/kinds/skills/public/upload",
            headers={"Authorization": f"Bearer {test_admin_token}"},
            data={"name": "download-unauth-test"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["id"]

        # Try to download without auth
        response = test_client.get(f"/api/v1/kinds/skills/public/{skill_id}/download")

        assert response.status_code == 401

    def test_download_public_skill_not_found(
        self, test_client: TestClient, test_token: str
    ):
        """Test downloading non-existent public skill returns 404"""
        response = test_client.get(
            "/api/v1/kinds/skills/public/99999/download",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 404

    def test_download_user_skill_as_public_fails(
        self, test_client: TestClient, test_token: str, test_admin_token: str
    ):
        """Test downloading user's private skill via public endpoint fails"""
        skill_md = "---\ndescription: Private skill\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create private skill as regular user
        create_response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers={"Authorization": f"Bearer {test_token}"},
            data={"name": "private-skill-test", "namespace": "default"},
            files={"file": ("test.zip", io.BytesIO(zip_content), "application/zip")},
        )
        assert create_response.status_code == 201

        skill_id = create_response.json()["metadata"]["labels"]["id"]

        # Try to download via public endpoint
        response = test_client.get(
            f"/api/v1/kinds/skills/public/{skill_id}/download",
            headers={"Authorization": f"Bearer {test_admin_token}"},
        )

        # Should fail because this is not a public skill (user_id != 0)
        assert response.status_code == 404
