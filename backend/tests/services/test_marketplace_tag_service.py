# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException

from app.schemas.marketplace_tags import MarketplaceTagItem
from app.services.marketplace_tag_service import marketplace_tag_service


def test_default_marketplace_tags_are_sorted(test_db):
    config = marketplace_tag_service.get_config(test_db)

    assert config.version == 0
    assert config.items[0].id == "product_design"
    assert config.items[-1].id == "daily_work"


def test_marketplace_tag_config_keeps_existing_ids(test_db, test_admin_user):
    config = marketplace_tag_service.get_config(test_db)
    items = list(config.items)
    items[0] = items[0].model_copy(update={"enabled": False})
    items.append(
        MarketplaceTagItem(
            id="project_management",
            name_zh="项目管理",
            name_en="Project Management",
            sort=15,
        )
    )

    saved = marketplace_tag_service.update_config(
        test_db,
        items=items,
        expected_version=config.version,
        current_user=test_admin_user,
    )

    assert saved.version == 1
    assert [item.id for item in saved.items[:3]] == [
        "product_design",
        "project_management",
        "technical_development",
    ]
    assert saved.items[0].enabled is False

    with pytest.raises(HTTPException, match="cannot be deleted"):
        marketplace_tag_service.update_config(
            test_db,
            items=saved.items[1:],
            expected_version=saved.version,
            current_user=test_admin_user,
        )


def test_resource_tag_validation_rejects_unknown_and_new_disabled_tags(
    test_db, test_admin_user
):
    config = marketplace_tag_service.get_config(test_db)
    items = [
        (
            item.model_copy(update={"enabled": False})
            if item.id == "product_design"
            else item
        )
        for item in config.items
    ]
    marketplace_tag_service.update_config(
        test_db,
        items=items,
        expected_version=config.version,
        current_user=test_admin_user,
    )

    with pytest.raises(HTTPException, match="Unknown marketplace tags"):
        marketplace_tag_service.validate_resource_tags(
            test_db,
            ["not_configured"],
            require_nonempty=True,
        )
    with pytest.raises(HTTPException, match="Disabled marketplace tags"):
        marketplace_tag_service.validate_resource_tags(
            test_db,
            ["product_design"],
            require_nonempty=True,
        )

    assert marketplace_tag_service.validate_resource_tags(
        test_db,
        ["product_design"],
        existing_tags=["product_design"],
        require_nonempty=True,
    ) == ["product_design"]


def test_marketplace_tag_config_rejects_stale_version(test_db, test_admin_user):
    config = marketplace_tag_service.get_config(test_db)
    saved = marketplace_tag_service.update_config(
        test_db,
        items=config.items,
        expected_version=config.version,
        current_user=test_admin_user,
    )
    updated_items = list(saved.items)
    updated_items[0] = updated_items[0].model_copy(
        update={"name_en": "Updated Product & Design"}
    )
    updated = marketplace_tag_service.update_config(
        test_db,
        items=updated_items,
        expected_version=saved.version,
        current_user=test_admin_user,
    )

    assert updated.version == 2
    assert updated.items[0].name_en == "Updated Product & Design"

    with pytest.raises(HTTPException) as exc_info:
        marketplace_tag_service.update_config(
            test_db,
            items=saved.items,
            expected_version=config.version,
            current_user=test_admin_user,
        )

    assert exc_info.value.status_code == 409
