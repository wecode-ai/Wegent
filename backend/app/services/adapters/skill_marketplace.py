# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill Marketplace service for managing skill categories, marketplace skills, and collections.

This service handles:
- SkillCategory CRD management (admin only)
- MarketplaceSkill CRD management (publish/unpublish/update)
- Skill collection (users can collect marketplace skills)
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.models.user import User
from app.schemas.kind import (
    CollectionItem,
    MarketplaceCategoryInfo,
    MarketplacePublisherInfo,
    MarketplaceSkill,
    MarketplaceSkillDetailResponse,
    MarketplaceSkillListResponse,
    MarketplaceSkillSpec,
    MarketplaceSkillStatus,
    ObjectMeta,
    PublishToMarketplaceRequest,
    SkillCategory,
    SkillCategoryListResponse,
    SkillCategoryResponse,
    SkillCategorySpec,
    SkillCategoryStatus,
    SourceSkillRef,
)

# Constants for marketplace resources
MARKETPLACE_USER_ID = 0  # System-level resources
MARKETPLACE_NAMESPACE = "default"


class SkillCategoryService:
    """Service for managing SkillCategory CRDs (admin only)"""

    def list_categories(self, db: Session) -> SkillCategoryListResponse:
        """
        List all skill categories with skill counts.

        Returns categories sorted by sortOrder, each with the count of
        active marketplace skills in that category.
        """
        # Get all active categories
        categories = (
            db.query(Kind)
            .filter(
                Kind.user_id == MARKETPLACE_USER_ID,
                Kind.kind == "SkillCategory",
                Kind.namespace == MARKETPLACE_NAMESPACE,
                Kind.is_active == True,  # noqa: E712
            )
            .all()
        )

        # Count skills per category
        result_items = []
        for cat in categories:
            spec = cat.json.get("spec", {})

            # Count active marketplace skills in this category
            skill_count = (
                db.query(func.count(Kind.id))
                .filter(
                    Kind.kind == "MarketplaceSkill",
                    Kind.is_active == True,  # noqa: E712
                    func.json_extract(Kind.json, "$.spec.category") == cat.name,
                )
                .scalar()
                or 0
            )

            result_items.append(
                SkillCategoryResponse(
                    name=cat.name,
                    displayName=spec.get("displayName", ""),
                    displayNameEn=spec.get("displayNameEn", ""),
                    description=spec.get("description"),
                    descriptionEn=spec.get("descriptionEn"),
                    icon=spec.get("icon"),
                    sortOrder=spec.get("sortOrder", 0),
                    skillCount=skill_count,
                )
            )

        # Sort by sortOrder
        result_items.sort(key=lambda x: x.sortOrder)
        return SkillCategoryListResponse(items=result_items)

    def get_category_by_name(
        self, db: Session, *, name: str
    ) -> Optional[SkillCategoryResponse]:
        """Get a category by name"""
        cat = (
            db.query(Kind)
            .filter(
                Kind.user_id == MARKETPLACE_USER_ID,
                Kind.kind == "SkillCategory",
                Kind.name == name,
                Kind.namespace == MARKETPLACE_NAMESPACE,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not cat:
            return None

        spec = cat.json.get("spec", {})

        # Count skills
        skill_count = (
            db.query(func.count(Kind.id))
            .filter(
                Kind.kind == "MarketplaceSkill",
                Kind.is_active == True,  # noqa: E712
                func.json_extract(Kind.json, "$.spec.category") == name,
            )
            .scalar()
            or 0
        )

        return SkillCategoryResponse(
            name=cat.name,
            displayName=spec.get("displayName", ""),
            displayNameEn=spec.get("displayNameEn", ""),
            description=spec.get("description"),
            descriptionEn=spec.get("descriptionEn"),
            icon=spec.get("icon"),
            sortOrder=spec.get("sortOrder", 0),
            skillCount=skill_count,
        )

    def create_category(
        self,
        db: Session,
        *,
        name: str,
        display_name: str,
        display_name_en: str,
        description: Optional[str] = None,
        description_en: Optional[str] = None,
        icon: Optional[str] = None,
        sort_order: int = 0,
    ) -> SkillCategoryResponse:
        """Create a new skill category (admin only)"""
        # Check if name already exists
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == MARKETPLACE_USER_ID,
                Kind.kind == "SkillCategory",
                Kind.name == name,
                Kind.namespace == MARKETPLACE_NAMESPACE,
            )
            .first()
        )

        if existing:
            if existing.is_active:
                raise HTTPException(
                    status_code=400, detail=f"Category '{name}' already exists"
                )
            # Restore soft-deleted category
            existing.is_active = True
            existing.json = self._build_category_json(
                name, display_name, display_name_en, description, description_en, icon, sort_order
            )
            flag_modified(existing, "json")
            db.commit()
            db.refresh(existing)
            return SkillCategoryResponse(
                name=name,
                displayName=display_name,
                displayNameEn=display_name_en,
                description=description,
                descriptionEn=description_en,
                icon=icon,
                sortOrder=sort_order,
                skillCount=0,
            )

        # Create new category
        category_kind = Kind(
            user_id=MARKETPLACE_USER_ID,
            kind="SkillCategory",
            name=name,
            namespace=MARKETPLACE_NAMESPACE,
            json=self._build_category_json(
                name, display_name, display_name_en, description, description_en, icon, sort_order
            ),
            is_active=True,
        )
        db.add(category_kind)
        db.commit()
        db.refresh(category_kind)

        return SkillCategoryResponse(
            name=name,
            displayName=display_name,
            displayNameEn=display_name_en,
            description=description,
            descriptionEn=description_en,
            icon=icon,
            sortOrder=sort_order,
            skillCount=0,
        )

    def update_category(
        self,
        db: Session,
        *,
        name: str,
        display_name: Optional[str] = None,
        display_name_en: Optional[str] = None,
        description: Optional[str] = None,
        description_en: Optional[str] = None,
        icon: Optional[str] = None,
        sort_order: Optional[int] = None,
    ) -> SkillCategoryResponse:
        """Update a skill category (admin only)"""
        cat = (
            db.query(Kind)
            .filter(
                Kind.user_id == MARKETPLACE_USER_ID,
                Kind.kind == "SkillCategory",
                Kind.name == name,
                Kind.namespace == MARKETPLACE_NAMESPACE,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not cat:
            raise HTTPException(status_code=404, detail=f"Category '{name}' not found")

        spec = cat.json.get("spec", {})

        # Update fields if provided
        if display_name is not None:
            spec["displayName"] = display_name
        if display_name_en is not None:
            spec["displayNameEn"] = display_name_en
        if description is not None:
            spec["description"] = description
        if description_en is not None:
            spec["descriptionEn"] = description_en
        if icon is not None:
            spec["icon"] = icon
        if sort_order is not None:
            spec["sortOrder"] = sort_order

        cat.json["spec"] = spec
        flag_modified(cat, "json")
        db.commit()
        db.refresh(cat)

        # Get skill count
        skill_count = (
            db.query(func.count(Kind.id))
            .filter(
                Kind.kind == "MarketplaceSkill",
                Kind.is_active == True,  # noqa: E712
                func.json_extract(Kind.json, "$.spec.category") == name,
            )
            .scalar()
            or 0
        )

        return SkillCategoryResponse(
            name=name,
            displayName=spec.get("displayName", ""),
            displayNameEn=spec.get("displayNameEn", ""),
            description=spec.get("description"),
            descriptionEn=spec.get("descriptionEn"),
            icon=spec.get("icon"),
            sortOrder=spec.get("sortOrder", 0),
            skillCount=skill_count,
        )

    def delete_category(self, db: Session, *, name: str) -> None:
        """
        Delete a skill category (admin only).

        Raises error if the category has skills.
        """
        cat = (
            db.query(Kind)
            .filter(
                Kind.user_id == MARKETPLACE_USER_ID,
                Kind.kind == "SkillCategory",
                Kind.name == name,
                Kind.namespace == MARKETPLACE_NAMESPACE,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not cat:
            raise HTTPException(status_code=404, detail=f"Category '{name}' not found")

        # Check if category has skills
        skill_count = (
            db.query(func.count(Kind.id))
            .filter(
                Kind.kind == "MarketplaceSkill",
                Kind.is_active == True,  # noqa: E712
                func.json_extract(Kind.json, "$.spec.category") == name,
            )
            .scalar()
            or 0
        )

        if skill_count > 0:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot delete category '{name}' with {skill_count} skills. "
                "Please move or delete the skills first.",
            )

        # Soft delete
        cat.is_active = False
        db.commit()

    def _build_category_json(
        self,
        name: str,
        display_name: str,
        display_name_en: str,
        description: Optional[str],
        description_en: Optional[str],
        icon: Optional[str],
        sort_order: int,
    ) -> Dict[str, Any]:
        """Build SkillCategory JSON structure"""
        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "SkillCategory",
            "metadata": {"name": name, "namespace": MARKETPLACE_NAMESPACE},
            "spec": {
                "displayName": display_name,
                "displayNameEn": display_name_en,
                "description": description,
                "descriptionEn": description_en,
                "icon": icon,
                "sortOrder": sort_order,
            },
            "status": {"state": "Available"},
        }


class MarketplaceSkillService:
    """Service for managing MarketplaceSkill CRDs"""

    def __init__(self):
        self.category_service = SkillCategoryService()

    def list_marketplace_skills(
        self,
        db: Session,
        *,
        skip: int = 0,
        limit: int = 20,
        search: Optional[str] = None,
        category: Optional[str] = None,
        tags: Optional[List[str]] = None,
        bind_shells: Optional[List[str]] = None,
        sort_by: str = "downloadCount",
        sort_order: str = "desc",
    ) -> MarketplaceSkillListResponse:
        """
        List marketplace skills with filtering and pagination.

        Args:
            db: Database session
            skip: Number of records to skip
            limit: Maximum number of records to return
            search: Search in name, description, marketDescription
            category: Filter by category
            tags: Filter by tags (any match)
            bind_shells: Filter by shell types (any match)
            sort_by: Sort field (downloadCount, createdAt, name)
            sort_order: Sort direction (asc, desc)

        Returns:
            Paginated list of marketplace skills
        """
        query = db.query(Kind).filter(
            Kind.kind == "MarketplaceSkill",
            Kind.is_active == True,  # noqa: E712
        )

        # Search filter
        if search:
            search_pattern = f"%{search}%"
            query = query.filter(
                or_(
                    Kind.name.ilike(search_pattern),
                    func.json_extract(Kind.json, "$.spec.description").ilike(
                        search_pattern
                    ),
                    func.json_extract(Kind.json, "$.spec.marketDescription").ilike(
                        search_pattern
                    ),
                    func.json_extract(Kind.json, "$.spec.displayName").ilike(
                        search_pattern
                    ),
                )
            )

        # Category filter
        if category:
            query = query.filter(
                func.json_extract(Kind.json, "$.spec.category") == category
            )

        # Tags filter (any match) - using JSON_CONTAINS
        if tags:
            tag_conditions = []
            for tag in tags:
                tag_conditions.append(
                    func.json_contains(
                        func.json_extract(Kind.json, "$.spec.tags"),
                        func.json_quote(tag),
                    )
                )
            query = query.filter(or_(*tag_conditions))

        # BindShells filter (any match)
        if bind_shells:
            shell_conditions = []
            for shell in bind_shells:
                shell_conditions.append(
                    func.json_contains(
                        func.json_extract(Kind.json, "$.spec.bindShells"),
                        func.json_quote(shell),
                    )
                )
            query = query.filter(or_(*shell_conditions))

        # Get total count before pagination
        total = query.count()

        # Sorting
        if sort_by == "downloadCount":
            sort_col = func.json_extract(Kind.json, "$.spec.downloadCount")
        elif sort_by == "createdAt":
            sort_col = Kind.created_at
        else:  # name
            sort_col = Kind.name

        if sort_order == "desc":
            query = query.order_by(sort_col.desc())
        else:
            query = query.order_by(sort_col.asc())

        # Pagination
        skills = query.offset(skip).limit(limit).all()

        items = [self._kind_to_marketplace_skill(s) for s in skills]

        return MarketplaceSkillListResponse(
            items=items, total=total, skip=skip, limit=limit
        )

    def get_marketplace_skill_detail(
        self,
        db: Session,
        *,
        marketplace_skill_id: int,
        current_user_id: int,
    ) -> MarketplaceSkillDetailResponse:
        """
        Get marketplace skill detail with publisher and category info.

        Args:
            db: Database session
            marketplace_skill_id: MarketplaceSkill Kind.id
            current_user_id: Current user's ID for checking collection status

        Returns:
            Skill detail with additional context
        """
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == marketplace_skill_id,
                Kind.kind == "MarketplaceSkill",
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not skill_kind:
            raise HTTPException(status_code=404, detail="Marketplace skill not found")

        skill = self._kind_to_marketplace_skill(skill_kind)
        spec = skill_kind.json.get("spec", {})

        # Get publisher info
        publisher_id = skill_kind.user_id
        publisher = db.query(User).filter(User.id == publisher_id).first()
        publisher_info = MarketplacePublisherInfo(
            id=publisher_id,
            username=publisher.username if publisher else "Unknown",
            avatar=publisher.avatar if publisher else None,
        )

        # Get category info
        category_name = spec.get("category", "")
        category_response = self.category_service.get_category_by_name(
            db, name=category_name
        )
        category_info = MarketplaceCategoryInfo(
            name=category_name,
            displayName=category_response.displayName if category_response else category_name,
        )

        # Check if current user has collected this skill
        is_collected = self._check_is_collected(
            db, marketplace_skill_id=marketplace_skill_id, user_id=current_user_id
        )

        return MarketplaceSkillDetailResponse(
            skill=skill,
            publisher=publisher_info,
            category=category_info,
            is_collected=is_collected,
        )

    def publish_to_marketplace(
        self,
        db: Session,
        *,
        request: PublishToMarketplaceRequest,
        user_id: int,
    ) -> int:
        """
        Publish a skill to the marketplace.

        Args:
            db: Database session
            request: Publish request with skill_id and category
            user_id: Publisher's user ID

        Returns:
            Created MarketplaceSkill Kind.id
        """
        # Validate source skill exists and belongs to user
        source_skill = (
            db.query(Kind)
            .filter(
                Kind.id == request.skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not source_skill:
            raise HTTPException(
                status_code=404,
                detail="Source skill not found or you don't have permission to publish it",
            )

        source_spec = source_skill.json.get("spec", {})

        # Validate skill has bindShells
        if not source_spec.get("bindShells"):
            raise HTTPException(
                status_code=400,
                detail="Cannot publish skill without bindShells configuration",
            )

        # Validate category exists
        category = self.category_service.get_category_by_name(db, name=request.category)
        if not category:
            raise HTTPException(
                status_code=400,
                detail=f"Category '{request.category}' does not exist",
            )

        # Check if already published (same source skill)
        existing = (
            db.query(Kind)
            .filter(
                Kind.kind == "MarketplaceSkill",
                Kind.user_id == user_id,
                Kind.is_active == True,  # noqa: E712
                func.json_extract(Kind.json, "$.spec.sourceSkillRef.skill_id")
                == request.skill_id,
            )
            .first()
        )

        if existing:
            raise HTTPException(
                status_code=400,
                detail="This skill is already published to the marketplace",
            )

        # Build MarketplaceSkill JSON
        marketplace_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "MarketplaceSkill",
            "metadata": {"name": source_skill.name, "namespace": MARKETPLACE_NAMESPACE},
            "spec": {
                "description": source_spec.get("description", ""),
                "displayName": source_spec.get("displayName"),
                "version": source_spec.get("version"),
                "author": source_spec.get("author"),
                "tags": source_spec.get("tags"),
                "bindShells": source_spec.get("bindShells"),
                "category": request.category,
                "marketDescription": request.market_description,
                "readme": request.readme,
                "downloadCount": 0,
                "sourceSkillRef": {
                    "skill_id": source_skill.id,
                    "namespace": source_skill.namespace,
                    "name": source_skill.name,
                    "user_id": user_id,
                },
            },
            "status": {"state": "Available"},
        }

        marketplace_kind = Kind(
            user_id=user_id,
            kind="MarketplaceSkill",
            name=source_skill.name,
            namespace=MARKETPLACE_NAMESPACE,
            json=marketplace_json,
            is_active=True,
        )
        db.add(marketplace_kind)
        db.commit()
        db.refresh(marketplace_kind)

        return marketplace_kind.id

    def update_marketplace_skill(
        self,
        db: Session,
        *,
        marketplace_skill_id: int,
        user_id: int,
        category: Optional[str] = None,
        market_description: Optional[str] = None,
        readme: Optional[str] = None,
    ) -> MarketplaceSkill:
        """
        Update a marketplace skill.

        Only the publisher can update their marketplace skill.
        """
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == marketplace_skill_id,
                Kind.kind == "MarketplaceSkill",
                Kind.user_id == user_id,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not skill_kind:
            raise HTTPException(
                status_code=404,
                detail="Marketplace skill not found or you don't have permission to update it",
            )

        spec = skill_kind.json.get("spec", {})

        # Validate new category if provided
        if category is not None:
            category_obj = self.category_service.get_category_by_name(db, name=category)
            if not category_obj:
                raise HTTPException(
                    status_code=400, detail=f"Category '{category}' does not exist"
                )
            spec["category"] = category

        if market_description is not None:
            spec["marketDescription"] = market_description

        if readme is not None:
            spec["readme"] = readme

        skill_kind.json["spec"] = spec
        flag_modified(skill_kind, "json")
        db.commit()
        db.refresh(skill_kind)

        return self._kind_to_marketplace_skill(skill_kind)

    def unpublish_from_marketplace(
        self,
        db: Session,
        *,
        marketplace_skill_id: int,
        user_id: int,
        is_admin: bool = False,
    ) -> None:
        """
        Unpublish (soft delete) a skill from the marketplace.

        Publisher or admin can unpublish.
        """
        query = db.query(Kind).filter(
            Kind.id == marketplace_skill_id,
            Kind.kind == "MarketplaceSkill",
            Kind.is_active == True,  # noqa: E712
        )

        if not is_admin:
            query = query.filter(Kind.user_id == user_id)

        skill_kind = query.first()

        if not skill_kind:
            raise HTTPException(
                status_code=404,
                detail="Marketplace skill not found or you don't have permission to unpublish it",
            )

        skill_kind.is_active = False
        db.commit()

    def get_my_published_skills(
        self, db: Session, *, user_id: int
    ) -> List[MarketplaceSkill]:
        """Get skills published by the current user"""
        skills = (
            db.query(Kind)
            .filter(
                Kind.kind == "MarketplaceSkill",
                Kind.user_id == user_id,
                Kind.is_active == True,  # noqa: E712
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
        return [self._kind_to_marketplace_skill(s) for s in skills]

    def sync_from_source_skill(
        self,
        db: Session,
        *,
        source_skill_id: int,
        user_id: int,
    ) -> None:
        """
        Sync marketplace skill content from source skill.

        Called when source skill is updated.
        """
        # Find marketplace skills linked to this source skill
        marketplace_skills = (
            db.query(Kind)
            .filter(
                Kind.kind == "MarketplaceSkill",
                Kind.is_active == True,  # noqa: E712
                func.json_extract(Kind.json, "$.spec.sourceSkillRef.skill_id")
                == source_skill_id,
                func.json_extract(Kind.json, "$.spec.sourceSkillRef.user_id") == user_id,
            )
            .all()
        )

        if not marketplace_skills:
            return

        # Get source skill
        source_skill = (
            db.query(Kind)
            .filter(
                Kind.id == source_skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not source_skill:
            return

        source_spec = source_skill.json.get("spec", {})

        # Fields to sync from source
        sync_fields = [
            "description",
            "displayName",
            "version",
            "author",
            "tags",
            "bindShells",
        ]

        for ms in marketplace_skills:
            for field in sync_fields:
                if field in source_spec:
                    ms.json["spec"][field] = source_spec[field]
            flag_modified(ms, "json")

        db.commit()

    def _check_is_collected(
        self, db: Session, *, marketplace_skill_id: int, user_id: int
    ) -> bool:
        """Check if user has collected a marketplace skill"""
        collection = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.user_id == user_id,
                Kind.is_active == True,  # noqa: E712
                func.json_extract(Kind.json, "$.spec.ref.marketplace_skill_id")
                == marketplace_skill_id,
            )
            .first()
        )
        return collection is not None

    def _kind_to_marketplace_skill(self, kind: Kind) -> MarketplaceSkill:
        """Convert Kind to MarketplaceSkill"""
        json_data = kind.json
        spec_data = json_data.get("spec", {})
        source_ref_data = spec_data.get("sourceSkillRef", {})

        return MarketplaceSkill(
            apiVersion=json_data.get("apiVersion", "agent.wecode.io/v1"),
            kind="MarketplaceSkill",
            metadata=ObjectMeta(
                name=kind.name,
                namespace=kind.namespace,
                labels={"id": str(kind.id)},
            ),
            spec=MarketplaceSkillSpec(
                description=spec_data.get("description", ""),
                displayName=spec_data.get("displayName"),
                version=spec_data.get("version"),
                author=spec_data.get("author"),
                tags=spec_data.get("tags"),
                bindShells=spec_data.get("bindShells"),
                category=spec_data.get("category", ""),
                marketDescription=spec_data.get("marketDescription"),
                readme=spec_data.get("readme"),
                downloadCount=spec_data.get("downloadCount", 0),
                sourceSkillRef=SourceSkillRef(
                    skill_id=source_ref_data.get("skill_id", 0),
                    namespace=source_ref_data.get("namespace", "default"),
                    name=source_ref_data.get("name", ""),
                    user_id=source_ref_data.get("user_id", 0),
                ),
            ),
            status=MarketplaceSkillStatus(
                state=json_data.get("status", {}).get("state", "Available")
            ),
        )


class SkillCollectionService:
    """Service for managing skill collections (user favorites)"""

    def __init__(self):
        self.marketplace_service = MarketplaceSkillService()

    def collect_skill(
        self,
        db: Session,
        *,
        marketplace_skill_id: int,
        user_id: int,
    ) -> int:
        """
        Collect (favorite) a marketplace skill.

        Creates a lightweight Skill record with ref pointing to the marketplace skill.

        Returns:
            Created collection Skill Kind.id
        """
        # Validate marketplace skill exists
        marketplace_skill = (
            db.query(Kind)
            .filter(
                Kind.id == marketplace_skill_id,
                Kind.kind == "MarketplaceSkill",
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not marketplace_skill:
            raise HTTPException(
                status_code=404, detail="Marketplace skill not found or has been unpublished"
            )

        ms_spec = marketplace_skill.json.get("spec", {})
        skill_name = marketplace_skill.name

        # Check if already collected
        existing_collection = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.user_id == user_id,
                Kind.is_active == True,  # noqa: E712
                func.json_extract(Kind.json, "$.spec.ref.marketplace_skill_id")
                == marketplace_skill_id,
            )
            .first()
        )

        if existing_collection:
            raise HTTPException(
                status_code=400, detail="You have already collected this skill"
            )

        # Check for name conflict with user's existing skills
        existing_skill = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.user_id == user_id,
                Kind.name == skill_name,
                Kind.namespace == "default",
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if existing_skill:
            # Check if it's a different skill (not a collection ref to this marketplace skill)
            existing_ref = existing_skill.json.get("spec", {}).get("ref")
            if not existing_ref or existing_ref.get("marketplace_skill_id") != marketplace_skill_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"You already have a skill named '{skill_name}'. "
                    "Please rename your skill first or use a different name.",
                )

        # Create collection record (Skill with ref only)
        collected_at = datetime.now(timezone.utc).isoformat()
        collection_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": skill_name, "namespace": "default"},
            "spec": {
                "description": "",  # Empty for ref-only skills
                "ref": {
                    "marketplace_skill_id": marketplace_skill_id,
                    "namespace": marketplace_skill.namespace,
                    "name": skill_name,
                    "user_id": marketplace_skill.user_id,
                    "collected_at": collected_at,
                },
            },
            "status": {"state": "Available"},
        }

        collection_kind = Kind(
            user_id=user_id,
            kind="Skill",
            name=skill_name,
            namespace="default",
            json=collection_json,
            is_active=True,
        )
        db.add(collection_kind)

        # Increment download count
        ms_spec["downloadCount"] = ms_spec.get("downloadCount", 0) + 1
        marketplace_skill.json["spec"] = ms_spec
        flag_modified(marketplace_skill, "json")

        db.commit()
        db.refresh(collection_kind)

        return collection_kind.id

    def uncollect_skill(
        self,
        db: Session,
        *,
        marketplace_skill_id: int,
        user_id: int,
    ) -> None:
        """
        Remove a skill from user's collection.

        Finds and deletes the collection record, decrements download count.
        """
        # Find collection record
        collection = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.user_id == user_id,
                Kind.is_active == True,  # noqa: E712
                func.json_extract(Kind.json, "$.spec.ref.marketplace_skill_id")
                == marketplace_skill_id,
            )
            .first()
        )

        if not collection:
            raise HTTPException(
                status_code=404, detail="Collection not found"
            )

        # Delete collection
        db.delete(collection)

        # Decrement download count on marketplace skill (if still exists)
        marketplace_skill = (
            db.query(Kind)
            .filter(
                Kind.id == marketplace_skill_id,
                Kind.kind == "MarketplaceSkill",
            )
            .first()
        )

        if marketplace_skill:
            ms_spec = marketplace_skill.json.get("spec", {})
            current_count = ms_spec.get("downloadCount", 0)
            ms_spec["downloadCount"] = max(0, current_count - 1)
            marketplace_skill.json["spec"] = ms_spec
            flag_modified(marketplace_skill, "json")

        db.commit()

    def get_my_collections(
        self, db: Session, *, user_id: int
    ) -> List[CollectionItem]:
        """
        Get user's collected skills with marketplace skill info.

        Returns collection items with availability status.
        """
        # Get all collection records (Skills with ref)
        collections = (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.user_id == user_id,
                Kind.is_active == True,  # noqa: E712
                func.json_extract(Kind.json, "$.spec.ref") != None,  # noqa: E711
            )
            .order_by(Kind.created_at.desc())
            .all()
        )

        result = []
        for col in collections:
            ref = col.json.get("spec", {}).get("ref", {})
            marketplace_skill_id = ref.get("marketplace_skill_id")
            collected_at = ref.get("collected_at", "")

            # Get marketplace skill
            marketplace_skill_kind = None
            is_available = False

            if marketplace_skill_id:
                marketplace_skill_kind = (
                    db.query(Kind)
                    .filter(
                        Kind.id == marketplace_skill_id,
                        Kind.kind == "MarketplaceSkill",
                    )
                    .first()
                )
                if marketplace_skill_kind and marketplace_skill_kind.is_active:
                    is_available = True

            result.append(
                CollectionItem(
                    collection_id=col.id,
                    collected_at=collected_at,
                    marketplace_skill=(
                        self.marketplace_service._kind_to_marketplace_skill(
                            marketplace_skill_kind
                        )
                        if marketplace_skill_kind
                        else None
                    ),
                    is_available=is_available,
                )
            )

        return result


# Singleton instances
skill_category_service = SkillCategoryService()
marketplace_skill_service = MarketplaceSkillService()
skill_collection_service = SkillCollectionService()
