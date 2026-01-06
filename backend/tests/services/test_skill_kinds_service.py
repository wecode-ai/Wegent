# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Integration tests for SkillKindsService
"""
import io
import zipfile

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.adapters.skill_kinds import SkillKindsService, skill_kinds_service


@pytest.mark.integration
class TestSkillKindsService:
    """Test SkillKindsService class"""

    @staticmethod
    def create_test_zip(skill_md_content: str, zip_name: str = "test") -> bytes:
        """Create a test ZIP with SKILL.md in proper structure"""
        zip_buffer = io.BytesIO()
        folder_name = zip_name.replace(".zip", "")
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(f"{folder_name}/SKILL.md", skill_md_content)
            zf.writestr(f"{folder_name}/script.py", "print('test')")
        return zip_buffer.getvalue()

    def test_create_skill_success(self, test_db: Session, test_user: User):
        """Test successful skill creation"""
        service = SkillKindsService()
        skill_md = """---
description: "Test debugging skill"
version: "1.0.0"
author: "Test Author"
tags: ["debug", "test"]
---

"""
        zip_content = self.create_test_zip(skill_md)

        skill = service.create_skill(
            db=test_db,
            name="test-debugger",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_user.id,
        )

        assert skill.metadata.name == "test-debugger"
        assert skill.metadata.namespace == "default"
        assert skill.spec.description == "Test debugging skill"
        assert skill.spec.version == "1.0.0"
        assert skill.spec.author == "Test Author"
        assert skill.spec.tags == ["debug", "test"]
        assert skill.status.state == "Available"
        assert skill.status.fileSize == len(zip_content)
        assert len(skill.status.fileHash) == 64

    def test_create_skill_duplicate_name(self, test_db: Session, test_user: User):
        """Test creating skill with duplicate name fails"""
        service = SkillKindsService()
        skill_md = "---\ndescription: Test skill\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create first skill
        service.create_skill(
            db=test_db,
            name="duplicate-skill",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_user.id,
        )

        # Try to create second skill with same name
        with pytest.raises(HTTPException) as exc_info:
            service.create_skill(
                db=test_db,
                name="duplicate-skill",
                namespace="default",
                file_content=zip_content,
                file_name="test.zip",
                user_id=test_user.id,
            )

        assert exc_info.value.status_code == 400
        assert "already exists" in exc_info.value.detail

    def test_create_skill_different_users_same_name(
        self, test_db: Session, test_user: User, test_admin_user: User
    ):
        """Test different users can create skills with the same name"""
        service = SkillKindsService()
        skill_md = "---\ndescription: Shared name skill\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # User 1 creates skill
        skill1 = service.create_skill(
            db=test_db,
            name="shared-name",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_user.id,
        )

        # User 2 creates skill with same name (should succeed)
        skill2 = service.create_skill(
            db=test_db,
            name="shared-name",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_admin_user.id,
        )

        assert skill1.metadata.name == skill2.metadata.name
        assert skill1.metadata.labels["id"] != skill2.metadata.labels["id"]

    def test_get_skill_by_id(self, test_db: Session, test_user: User):
        """Test retrieving skill by ID"""
        service = SkillKindsService()
        skill_md = "---\ndescription: Get by ID test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        created_skill = service.create_skill(
            db=test_db,
            name="get-by-id-test",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_user.id,
        )

        skill_id = int(created_skill.metadata.labels["id"])
        retrieved_skill = service.get_skill_by_id(
            db=test_db, skill_id=skill_id, user_id=test_user.id
        )

        assert retrieved_skill is not None
        assert retrieved_skill.metadata.name == "get-by-id-test"
        assert retrieved_skill.spec.description == "Get by ID test"

    def test_get_skill_by_id_wrong_user(
        self, test_db: Session, test_user: User, test_admin_user: User
    ):
        """Test user cannot access another user's skill"""
        service = SkillKindsService()
        skill_md = "---\ndescription: Private skill\n---\n"
        zip_content = self.create_test_zip(skill_md)

        created_skill = service.create_skill(
            db=test_db,
            name="private-skill",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_user.id,
        )

        skill_id = int(created_skill.metadata.labels["id"])

        # Admin user tries to access test_user's skill
        retrieved_skill = service.get_skill_by_id(
            db=test_db, skill_id=skill_id, user_id=test_admin_user.id
        )

        assert retrieved_skill is None

    def test_get_skill_by_name(self, test_db: Session, test_user: User):
        """Test retrieving skill by name"""
        service = SkillKindsService()
        skill_md = "---\ndescription: Get by name test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        service.create_skill(
            db=test_db,
            name="get-by-name-test",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_user.id,
        )

        retrieved_skill = service.get_skill_by_name(
            db=test_db,
            name="get-by-name-test",
            namespace="default",
            user_id=test_user.id,
        )

        assert retrieved_skill is not None
        assert retrieved_skill.metadata.name == "get-by-name-test"

    def test_list_skills(self, test_db: Session, test_user: User):
        """Test listing all skills for a user"""
        service = SkillKindsService()
        skill_md = "---\ndescription: List test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create 3 skills
        for i in range(3):
            service.create_skill(
                db=test_db,
                name=f"list-test-{i}",
                namespace="default",
                file_content=zip_content,
                file_name="test.zip",
                user_id=test_user.id,
            )

        skill_list = service.list_skills(
            db=test_db, user_id=test_user.id, skip=0, limit=10, namespace="default"
        )

        assert len(skill_list.items) == 3
        skill_names = [skill.metadata.name for skill in skill_list.items]
        assert "list-test-0" in skill_names
        assert "list-test-1" in skill_names
        assert "list-test-2" in skill_names

    def test_list_skills_pagination(self, test_db: Session, test_user: User):
        """Test skill list pagination"""
        service = SkillKindsService()
        skill_md = "---\ndescription: Pagination test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create 5 skills
        for i in range(5):
            service.create_skill(
                db=test_db,
                name=f"pagination-test-{i}",
                namespace="default",
                file_content=zip_content,
                file_name="test.zip",
                user_id=test_user.id,
            )

        # Get first 2 skills
        page1 = service.list_skills(
            db=test_db, user_id=test_user.id, skip=0, limit=2, namespace="default"
        )

        # Get next 2 skills
        page2 = service.list_skills(
            db=test_db, user_id=test_user.id, skip=2, limit=2, namespace="default"
        )

        assert len(page1.items) == 2
        assert len(page2.items) == 2
        # Verify no overlap
        page1_names = {s.metadata.name for s in page1.items}
        page2_names = {s.metadata.name for s in page2.items}
        assert page1_names.isdisjoint(page2_names)

    def test_update_skill(self, test_db: Session, test_user: User):
        """Test updating skill with new ZIP package"""
        service = SkillKindsService()

        # Create initial skill
        original_md = """---
description: "Original description"
version: "1.0.0"
---

"""
        original_zip = self.create_test_zip(original_md, "original.zip")

        created_skill = service.create_skill(
            db=test_db,
            name="update-test",
            namespace="default",
            file_content=original_zip,
            file_name="original.zip",
            user_id=test_user.id,
        )

        skill_id = int(created_skill.metadata.labels["id"])

        # Update with new ZIP
        updated_md = """---
description: "Updated description"
version: "2.0.0"
author: "New Author"
---

"""
        updated_zip = self.create_test_zip(updated_md, "updated.zip")

        updated_skill = service.update_skill(
            db=test_db,
            skill_id=skill_id,
            user_id=test_user.id,
            file_content=updated_zip,
            file_name="updated.zip",
        )

        assert updated_skill.metadata.name == "update-test"
        assert updated_skill.spec.description == "Updated description"
        assert updated_skill.spec.version == "2.0.0"
        assert updated_skill.spec.author == "New Author"
        assert updated_skill.status.fileSize == len(updated_zip)

    def test_update_skill_not_found(self, test_db: Session, test_user: User):
        """Test updating non-existent skill fails"""
        service = SkillKindsService()
        skill_md = "---\ndescription: Test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        with pytest.raises(HTTPException) as exc_info:
            service.update_skill(
                db=test_db,
                skill_id=99999,
                user_id=test_user.id,
                file_content=zip_content,
                file_name="test.zip",
            )

        assert exc_info.value.status_code == 404

    def test_delete_skill(self, test_db: Session, test_user: User):
        """Test deleting skill (soft delete for Kind, hard delete for SkillBinary)"""
        from app.models.skill_binary import SkillBinary

        service = SkillKindsService()
        skill_md = "---\ndescription: Delete test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        created_skill = service.create_skill(
            db=test_db,
            name="delete-test",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_user.id,
        )

        skill_id = int(created_skill.metadata.labels["id"])

        # Verify SkillBinary exists before deletion
        skill_binary_before = (
            test_db.query(SkillBinary).filter(SkillBinary.kind_id == skill_id).first()
        )
        assert (
            skill_binary_before is not None
        ), "SkillBinary should exist before deletion"

        # Delete skill
        service.delete_skill(db=test_db, skill_id=skill_id, user_id=test_user.id)

        # Verify skill is soft deleted (not accessible)
        retrieved_skill = service.get_skill_by_id(
            db=test_db, skill_id=skill_id, user_id=test_user.id
        )
        assert retrieved_skill is None

        # Verify SkillBinary is hard deleted (to free storage)
        skill_binary_after = (
            test_db.query(SkillBinary).filter(SkillBinary.kind_id == skill_id).first()
        )
        assert (
            skill_binary_after is None
        ), "SkillBinary should be deleted after skill deletion"

    def test_delete_skill_referenced_by_ghost(self, test_db: Session, test_user: User):
        """Test deleting skill fails when referenced by Ghost"""
        service = SkillKindsService()
        skill_md = "---\ndescription: Referenced skill\n---\n"
        zip_content = self.create_test_zip(skill_md)

        # Create skill
        created_skill = service.create_skill(
            db=test_db,
            name="referenced-skill",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_user.id,
        )

        skill_id = int(created_skill.metadata.labels["id"])

        # Create Ghost that references this skill
        ghost_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "test-ghost", "namespace": "default"},
            "spec": {"systemPrompt": "Test prompt", "skills": ["referenced-skill"]},
        }

        ghost_kind = Kind(
            user_id=test_user.id,
            kind="Ghost",
            name="test-ghost",
            namespace="default",
            json=ghost_json,
            is_active=True,
        )
        test_db.add(ghost_kind)
        test_db.commit()

        # Try to delete skill
        with pytest.raises(HTTPException) as exc_info:
            service.delete_skill(db=test_db, skill_id=skill_id, user_id=test_user.id)

        assert exc_info.value.status_code == 400
        # detail is now a dict with structured error info
        detail = exc_info.value.detail
        assert detail["code"] == "SKILL_REFERENCED"
        assert "referenced by Ghosts" in detail["message"]
        assert any(g["name"] == "test-ghost" for g in detail["referenced_ghosts"])

    def test_get_skill_binary(self, test_db: Session, test_user: User):
        """Test retrieving skill binary data"""
        service = SkillKindsService()
        skill_md = "---\ndescription: Binary test\n---\n"
        zip_content = self.create_test_zip(skill_md)

        created_skill = service.create_skill(
            db=test_db,
            name="binary-test",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_user.id,
        )

        skill_id = int(created_skill.metadata.labels["id"])

        binary_data = service.get_skill_binary(
            db=test_db, skill_id=skill_id, user_id=test_user.id
        )

        assert binary_data is not None
        assert binary_data == zip_content

    def test_get_skill_binary_wrong_user(
        self, test_db: Session, test_user: User, test_admin_user: User
    ):
        """Test user cannot access another user's skill binary"""
        service = SkillKindsService()
        skill_md = "---\ndescription: Private binary\n---\n"
        zip_content = self.create_test_zip(skill_md)

        created_skill = service.create_skill(
            db=test_db,
            name="private-binary",
            namespace="default",
            file_content=zip_content,
            file_name="test.zip",
            user_id=test_user.id,
        )

        skill_id = int(created_skill.metadata.labels["id"])

        # Admin user tries to access test_user's skill binary
        binary_data = service.get_skill_binary(
            db=test_db, skill_id=skill_id, user_id=test_admin_user.id
        )

        assert binary_data is None
