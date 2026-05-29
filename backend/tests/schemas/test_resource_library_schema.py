# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.resource_library import (
    ResourceLibraryListingCreate,
    ResourceLibraryResourceType,
)


def test_listing_create_accepts_agent_and_skill_types():
    for resource_type in ("agent", "skill"):
        payload = ResourceLibraryListingCreate(
            resource_type=resource_type,
            source_id=1,
            name=f"{resource_type}-demo",
            display_name=f"{resource_type} demo",
            description="Reusable resource",
            tags=["demo"],
            version="1.0.0",
        )

        assert payload.resource_type == resource_type


def test_listing_create_rejects_unknown_type():
    with pytest.raises(ValidationError):
        ResourceLibraryListingCreate(
            resource_type="plugin",
            source_id=1,
            name="bad",
            display_name="Bad",
            description="Bad resource",
            version="1.0.0",
        )


def test_resource_type_literal_values_are_stable():
    assert ResourceLibraryResourceType.__args__ == ("agent", "skill")
