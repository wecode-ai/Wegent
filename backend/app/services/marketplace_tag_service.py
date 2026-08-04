# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""System configuration and validation for marketplace tags."""

import json

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.system_config import SystemConfig
from app.models.user import User
from app.schemas.marketplace_tags import MarketplaceTagItem, MarketplaceTagsResponse

MARKETPLACE_TAGS_CONFIG_KEY = "marketplace_tags"
MAX_MARKETPLACE_TAGS_PER_RESOURCE = 3
MAX_SYSTEM_CONFIG_VALUE_LENGTH = 4096

DEFAULT_MARKETPLACE_TAGS = [
    MarketplaceTagItem(
        id="product_design",
        name_zh="产品与设计",
        name_en="Product & Design",
        sort=10,
    ),
    MarketplaceTagItem(
        id="technical_development",
        name_zh="技术开发",
        name_en="Technical Development",
        sort=20,
    ),
    MarketplaceTagItem(
        id="marketing_operations",
        name_zh="市场与运营",
        name_en="Marketing & Operations",
        sort=30,
    ),
    MarketplaceTagItem(
        id="content_creation",
        name_zh="内容创作",
        name_en="Content Creation",
        sort=40,
    ),
    MarketplaceTagItem(
        id="data_analysis",
        name_zh="数据分析",
        name_en="Data Analysis",
        sort=50,
    ),
    MarketplaceTagItem(
        id="sales_customer_service",
        name_zh="销售与客服",
        name_en="Sales & Customer Service",
        sort=60,
    ),
    MarketplaceTagItem(
        id="human_resources",
        name_zh="人力资源",
        name_en="Human Resources",
        sort=70,
    ),
    MarketplaceTagItem(
        id="finance",
        name_zh="财务管理",
        name_en="Finance",
        sort=80,
    ),
    MarketplaceTagItem(
        id="legal_security",
        name_zh="法务与安全",
        name_en="Legal & Security",
        sort=90,
    ),
    MarketplaceTagItem(
        id="daily_work",
        name_zh="日常工作",
        name_en="Daily Work",
        sort=100,
    ),
]


class MarketplaceTagService:
    """Read, persist, and validate the marketplace tag catalog."""

    def get_config(self, db: Session) -> MarketplaceTagsResponse:
        """Return persisted tags or the default catalog."""
        config = self._get_model(db)
        if config is None:
            return MarketplaceTagsResponse(
                version=0,
                items=self._sorted_items(DEFAULT_MARKETPLACE_TAGS),
            )
        raw_items = (config.config_value or {}).get("items", [])
        items = [MarketplaceTagItem.model_validate(item) for item in raw_items]
        return MarketplaceTagsResponse(
            version=config.version,
            items=self._sorted_items(items),
        )

    def update_config(
        self,
        db: Session,
        *,
        items: list[MarketplaceTagItem],
        expected_version: int,
        current_user: User,
    ) -> MarketplaceTagsResponse:
        """Persist a complete catalog while preserving stable existing IDs."""
        self._validate_unique_ids(items)
        current = self.get_config(db)
        if current.version != expected_version:
            raise HTTPException(
                status_code=409,
                detail="Marketplace tag configuration has changed; reload and retry",
            )
        next_ids = {item.id for item in items}
        removed_ids = {item.id for item in current.items} - next_ids
        if removed_ids:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Marketplace tags cannot be deleted; disable them instead: "
                    + ", ".join(sorted(removed_ids))
                ),
            )

        sorted_items = self._sorted_items(items)
        config_value = {"items": [item.model_dump() for item in sorted_items]}
        serialized = json.dumps(config_value, ensure_ascii=False)
        if len(serialized) > MAX_SYSTEM_CONFIG_VALUE_LENGTH:
            raise HTTPException(
                status_code=400,
                detail="Marketplace tag configuration is too large",
            )

        config = self._get_model(db)
        if config is None:
            config = SystemConfig(
                config_key=MARKETPLACE_TAGS_CONFIG_KEY,
                config_value=config_value,
                version=1,
                updated_by=current_user.id,
            )
            db.add(config)
            try:
                db.commit()
            except IntegrityError as exc:
                db.rollback()
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Marketplace tag configuration has changed; reload and retry"
                    ),
                ) from exc
        else:
            updated = (
                db.query(SystemConfig)
                .filter(
                    SystemConfig.config_key == MARKETPLACE_TAGS_CONFIG_KEY,
                    SystemConfig.version == expected_version,
                )
                .update(
                    {
                        SystemConfig._config_value: serialized,
                        SystemConfig.version: expected_version + 1,
                        SystemConfig.updated_by: current_user.id,
                        SystemConfig.updated_at: func.now(),
                    },
                    synchronize_session=False,
                )
            )
            if updated != 1:
                db.rollback()
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Marketplace tag configuration has changed; reload and retry"
                    ),
                )
            db.commit()
            config = self._get_model(db)
            if config is None:
                raise RuntimeError("Marketplace tag configuration disappeared")

        db.refresh(config)
        return MarketplaceTagsResponse(
            version=config.version,
            items=sorted_items,
        )

    def validate_resource_tags(
        self,
        db: Session,
        tags: list[str],
        *,
        existing_tags: list[str] | None = None,
        require_nonempty: bool,
    ) -> list[str]:
        """Normalize resource tags and enforce the configured catalog."""
        normalized = self._normalize_resource_tags(tags)
        if require_nonempty and not normalized:
            raise HTTPException(
                status_code=400,
                detail="At least one marketplace tag is required",
            )
        if len(normalized) > MAX_MARKETPLACE_TAGS_PER_RESOURCE:
            raise HTTPException(
                status_code=400,
                detail=(
                    "A resource can have at most "
                    f"{MAX_MARKETPLACE_TAGS_PER_RESOURCE} marketplace tags"
                ),
            )

        configured = {item.id: item for item in self.get_config(db).items}
        unknown = [tag for tag in normalized if tag not in configured]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail="Unknown marketplace tags: " + ", ".join(unknown),
            )

        retained = set(existing_tags or [])
        disabled = [
            tag
            for tag in normalized
            if not configured[tag].enabled and tag not in retained
        ]
        if disabled:
            raise HTTPException(
                status_code=400,
                detail="Disabled marketplace tags cannot be selected: "
                + ", ".join(disabled),
            )
        return normalized

    def _get_model(self, db: Session) -> SystemConfig | None:
        return (
            db.query(SystemConfig)
            .filter(SystemConfig.config_key == MARKETPLACE_TAGS_CONFIG_KEY)
            .first()
        )

    def _validate_unique_ids(self, items: list[MarketplaceTagItem]) -> None:
        seen: set[str] = set()
        duplicates: list[str] = []
        for item in items:
            if item.id in seen:
                duplicates.append(item.id)
            seen.add(item.id)
        if duplicates:
            raise HTTPException(
                status_code=400,
                detail="Duplicate marketplace tag IDs: "
                + ", ".join(sorted(set(duplicates))),
            )

    def _normalize_resource_tags(self, tags: list[str]) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()
        for value in tags:
            tag = value.strip()
            if not tag or tag in seen:
                continue
            seen.add(tag)
            result.append(tag)
        return result

    def _sorted_items(
        self, items: list[MarketplaceTagItem]
    ) -> list[MarketplaceTagItem]:
        return sorted(items, key=lambda item: (item.sort, item.id))


marketplace_tag_service = MarketplaceTagService()
