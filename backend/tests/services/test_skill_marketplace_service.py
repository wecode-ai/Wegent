# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for Skill Marketplace service
"""
import io
import zipfile
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.adapters.skill_marketplace import (
    MARKETPLACE_NAMESPACE,
    MARKETPLACE_USER_ID,
    MarketplaceSkillService,
    SkillCategoryService,
    SkillCollectionService,
    marketplace_skill_service,
    skill_category_service,
    skill_collection_service,
)
from app.schemas.kind import PublishToMarketplaceRequest


@pytest.fixture
def category_service() -> SkillCategoryService:
    """Get category service instance"""
    return SkillCategoryService()


@pytest.fixture
def marketplace_service() -> MarketplaceSkillService:
    """Get marketplace service instance"""
    return MarketplaceSkillService()


@pytest.fixture
def collection_service() -> SkillCollectionService:
    """Get collection service instance"""
    return SkillCollectionService()


@pytest.fixture
def sample_skill(test_db: Session, test_user: User) -> Kind:
    """Create a sample skill for testing"""
    skill_json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Skill",
        "metadata": {"name": "test-skill", "namespace": "default"},
        "spec": {
            "description": "Test skill description",
            "displayName": "Test Skill",
            "version": "1.0.0",
            "author": "Test Author",
            "tags": ["test", "sample"],
            "bindShells": ["ClaudeCode", "Chat"],
        },
        "status": {"state": "Available"},
    }
    skill = Kind(
        user_id=test_user.id,
        kind="Skill",
        name="test-skill",
        namespace="default",
        json=skill_json,
        is_active=True,
    )
    test_db.add(skill)
    test_db.commit()
    test_db.refresh(skill)
    return skill


@pytest.fixture
def sample_category(test_db: Session, category_service: SkillCategoryService) -> str:
    """Create a sample category for testing"""
    category_service.create_category(
        test_db,
        name="test-category",
        display_name="测试分类",
        display_name_en="Test Category",
        description="测试分类描述",
        description_en="Test category description",
        icon="code",
        sort_order=0,
    )
    return "test-category"


@pytest.mark.integration
class TestSkillCategoryService:
    """Test SkillCategoryService class"""

    def test_create_category_success(
        self, test_db: Session, category_service: SkillCategoryService
    ):
        """Test successful category creation"""
        result = category_service.create_category(
            test_db,
            name="development",
            display_name="开发工具",
            display_name_en="Development Tools",
            description="代码开发工具",
            description_en="Code development tools",
            icon="code",
            sort_order=0,
        )

        assert result.name == "development"
        assert result.displayName == "开发工具"
        assert result.displayNameEn == "Development Tools"
        assert result.icon == "code"
        assert result.sortOrder == 0
        assert result.skillCount == 0

    def test_create_category_duplicate_name(
        self, test_db: Session, category_service: SkillCategoryService
    ):
        """Test creating category with duplicate name fails"""
        category_service.create_category(
            test_db,
            name="duplicate-cat",
            display_name="重复分类",
            display_name_en="Duplicate Category",
        )

        with pytest.raises(HTTPException) as exc_info:
            category_service.create_category(
                test_db,
                name="duplicate-cat",
                display_name="另一个名称",
                display_name_en="Another Name",
            )

        assert exc_info.value.status_code == 400
        assert "already exists" in exc_info.value.detail

    def test_list_categories(
        self, test_db: Session, category_service: SkillCategoryService
    ):
        """Test listing all categories"""
        # Create multiple categories
        category_service.create_category(
            test_db,
            name="cat-a",
            display_name="分类A",
            display_name_en="Category A",
            sort_order=1,
        )
        category_service.create_category(
            test_db,
            name="cat-b",
            display_name="分类B",
            display_name_en="Category B",
            sort_order=0,
        )

        result = category_service.list_categories(test_db)

        assert len(result.items) >= 2
        # Should be sorted by sortOrder
        sort_orders = [c.sortOrder for c in result.items]
        assert sort_orders == sorted(sort_orders)

    def test_update_category(
        self, test_db: Session, category_service: SkillCategoryService
    ):
        """Test updating a category"""
        category_service.create_category(
            test_db,
            name="update-test",
            display_name="原始名称",
            display_name_en="Original Name",
            sort_order=0,
        )

        result = category_service.update_category(
            test_db,
            name="update-test",
            display_name="更新后名称",
            display_name_en="Updated Name",
            sort_order=5,
        )

        assert result.displayName == "更新后名称"
        assert result.displayNameEn == "Updated Name"
        assert result.sortOrder == 5

    def test_delete_category_success(
        self, test_db: Session, category_service: SkillCategoryService
    ):
        """Test deleting a category with no skills"""
        category_service.create_category(
            test_db,
            name="delete-test",
            display_name="待删除",
            display_name_en="To Delete",
        )

        category_service.delete_category(test_db, name="delete-test")

        result = category_service.get_category_by_name(test_db, name="delete-test")
        assert result is None


@pytest.mark.integration
class TestMarketplaceSkillService:
    """Test MarketplaceSkillService class"""

    def test_publish_to_marketplace_success(
        self,
        test_db: Session,
        marketplace_service: MarketplaceSkillService,
        sample_skill: Kind,
        sample_category: str,
    ):
        """Test successful skill publishing"""
        request = PublishToMarketplaceRequest(
            skill_id=sample_skill.id,
            category=sample_category,
            market_description="Market-specific description",
            readme="# Test Skill\n\nThis is a test.",
        )

        marketplace_skill_id = marketplace_service.publish_to_marketplace(
            test_db,
            request=request,
            user_id=sample_skill.user_id,
        )

        assert marketplace_skill_id > 0

        # Verify the marketplace skill was created
        ms = (
            test_db.query(Kind)
            .filter(Kind.id == marketplace_skill_id, Kind.kind == "MarketplaceSkill")
            .first()
        )
        assert ms is not None
        assert ms.json["spec"]["category"] == sample_category
        assert ms.json["spec"]["marketDescription"] == "Market-specific description"
        assert ms.json["spec"]["sourceSkillRef"]["skill_id"] == sample_skill.id

    def test_publish_without_bindshells_fails(
        self,
        test_db: Session,
        marketplace_service: MarketplaceSkillService,
        test_user: User,
        sample_category: str,
    ):
        """Test publishing skill without bindShells fails"""
        # Create skill without bindShells
        skill_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": "no-shells-skill", "namespace": "default"},
            "spec": {"description": "No shells"},
            "status": {"state": "Available"},
        }
        skill = Kind(
            user_id=test_user.id,
            kind="Skill",
            name="no-shells-skill",
            namespace="default",
            json=skill_json,
            is_active=True,
        )
        test_db.add(skill)
        test_db.commit()
        test_db.refresh(skill)

        request = PublishToMarketplaceRequest(
            skill_id=skill.id,
            category=sample_category,
        )

        with pytest.raises(HTTPException) as exc_info:
            marketplace_service.publish_to_marketplace(
                test_db,
                request=request,
                user_id=test_user.id,
            )

        assert exc_info.value.status_code == 400
        assert "bindShells" in exc_info.value.detail

    def test_publish_invalid_category_fails(
        self,
        test_db: Session,
        marketplace_service: MarketplaceSkillService,
        sample_skill: Kind,
    ):
        """Test publishing with invalid category fails"""
        request = PublishToMarketplaceRequest(
            skill_id=sample_skill.id,
            category="nonexistent-category",
        )

        with pytest.raises(HTTPException) as exc_info:
            marketplace_service.publish_to_marketplace(
                test_db,
                request=request,
                user_id=sample_skill.user_id,
            )

        assert exc_info.value.status_code == 400
        assert "does not exist" in exc_info.value.detail

    def test_list_marketplace_skills(
        self,
        test_db: Session,
        marketplace_service: MarketplaceSkillService,
        sample_skill: Kind,
        sample_category: str,
    ):
        """Test listing marketplace skills"""
        # First publish a skill
        request = PublishToMarketplaceRequest(
            skill_id=sample_skill.id,
            category=sample_category,
        )
        marketplace_service.publish_to_marketplace(
            test_db,
            request=request,
            user_id=sample_skill.user_id,
        )

        # List skills
        result = marketplace_service.list_marketplace_skills(test_db)

        assert result.total >= 1
        assert len(result.items) >= 1

    def test_list_marketplace_skills_with_category_filter(
        self,
        test_db: Session,
        marketplace_service: MarketplaceSkillService,
        sample_skill: Kind,
        sample_category: str,
        category_service: SkillCategoryService,
    ):
        """Test filtering marketplace skills by category"""
        # Create another category
        category_service.create_category(
            test_db,
            name="other-category",
            display_name="其他",
            display_name_en="Other",
        )

        # Publish skill to sample_category
        request = PublishToMarketplaceRequest(
            skill_id=sample_skill.id,
            category=sample_category,
        )
        marketplace_service.publish_to_marketplace(
            test_db,
            request=request,
            user_id=sample_skill.user_id,
        )

        # Filter by sample_category
        result = marketplace_service.list_marketplace_skills(
            test_db, category=sample_category
        )
        assert all(s.spec.category == sample_category for s in result.items)

        # Filter by other-category (should be empty)
        result2 = marketplace_service.list_marketplace_skills(
            test_db, category="other-category"
        )
        assert result2.total == 0


@pytest.mark.integration
class TestSkillCollectionService:
    """Test SkillCollectionService class"""

    def test_collect_skill_success(
        self,
        test_db: Session,
        marketplace_service: MarketplaceSkillService,
        collection_service: SkillCollectionService,
        sample_skill: Kind,
        sample_category: str,
        test_admin_user: User,
    ):
        """Test successfully collecting a marketplace skill"""
        # First publish the skill
        request = PublishToMarketplaceRequest(
            skill_id=sample_skill.id,
            category=sample_category,
        )
        marketplace_skill_id = marketplace_service.publish_to_marketplace(
            test_db,
            request=request,
            user_id=sample_skill.user_id,
        )

        # Collect the skill as a different user
        collection_id = collection_service.collect_skill(
            test_db,
            marketplace_skill_id=marketplace_skill_id,
            user_id=test_admin_user.id,
        )

        assert collection_id > 0

        # Verify the collection was created
        collection = (
            test_db.query(Kind)
            .filter(
                Kind.id == collection_id,
                Kind.kind == "Skill",
                Kind.user_id == test_admin_user.id,
            )
            .first()
        )
        assert collection is not None
        assert collection.json["spec"]["ref"]["marketplace_skill_id"] == marketplace_skill_id

    def test_collect_duplicate_fails(
        self,
        test_db: Session,
        marketplace_service: MarketplaceSkillService,
        collection_service: SkillCollectionService,
        sample_skill: Kind,
        sample_category: str,
        test_admin_user: User,
    ):
        """Test collecting same skill twice fails"""
        # Publish
        request = PublishToMarketplaceRequest(
            skill_id=sample_skill.id,
            category=sample_category,
        )
        marketplace_skill_id = marketplace_service.publish_to_marketplace(
            test_db,
            request=request,
            user_id=sample_skill.user_id,
        )

        # Collect once
        collection_service.collect_skill(
            test_db,
            marketplace_skill_id=marketplace_skill_id,
            user_id=test_admin_user.id,
        )

        # Try to collect again
        with pytest.raises(HTTPException) as exc_info:
            collection_service.collect_skill(
                test_db,
                marketplace_skill_id=marketplace_skill_id,
                user_id=test_admin_user.id,
            )

        assert exc_info.value.status_code == 400
        assert "already collected" in exc_info.value.detail

    def test_uncollect_skill_success(
        self,
        test_db: Session,
        marketplace_service: MarketplaceSkillService,
        collection_service: SkillCollectionService,
        sample_skill: Kind,
        sample_category: str,
        test_admin_user: User,
    ):
        """Test successfully removing a skill from collection"""
        # Publish
        request = PublishToMarketplaceRequest(
            skill_id=sample_skill.id,
            category=sample_category,
        )
        marketplace_skill_id = marketplace_service.publish_to_marketplace(
            test_db,
            request=request,
            user_id=sample_skill.user_id,
        )

        # Collect
        collection_service.collect_skill(
            test_db,
            marketplace_skill_id=marketplace_skill_id,
            user_id=test_admin_user.id,
        )

        # Uncollect
        collection_service.uncollect_skill(
            test_db,
            marketplace_skill_id=marketplace_skill_id,
            user_id=test_admin_user.id,
        )

        # Verify collection is removed
        collections = collection_service.get_my_collections(
            test_db, user_id=test_admin_user.id
        )
        assert len(collections) == 0

    def test_get_my_collections(
        self,
        test_db: Session,
        marketplace_service: MarketplaceSkillService,
        collection_service: SkillCollectionService,
        sample_skill: Kind,
        sample_category: str,
        test_admin_user: User,
    ):
        """Test getting user's collections"""
        # Publish
        request = PublishToMarketplaceRequest(
            skill_id=sample_skill.id,
            category=sample_category,
        )
        marketplace_skill_id = marketplace_service.publish_to_marketplace(
            test_db,
            request=request,
            user_id=sample_skill.user_id,
        )

        # Collect
        collection_service.collect_skill(
            test_db,
            marketplace_skill_id=marketplace_skill_id,
            user_id=test_admin_user.id,
        )

        # Get collections
        collections = collection_service.get_my_collections(
            test_db, user_id=test_admin_user.id
        )

        assert len(collections) == 1
        assert collections[0].is_available == True
        assert collections[0].marketplace_skill is not None
