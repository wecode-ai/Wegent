# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException

from app.api.endpoints.kind.skills import _build_uploaded_skill_source
from app.schemas.kind import SkillSource


def test_build_marketplace_skill_source() -> None:
    source = _build_uploaded_skill_source(
        "marketplace",
        "weibo",
        "owner_skill-key",
        "skill-key",
    )

    assert source["type"] == "marketplace"
    assert source["provider_key"] == "weibo"
    assert source["skill_key"] == "owner_skill-key"
    assert source["original_skill_key"] == "skill-key"
    assert source["imported_at"]


def test_marketplace_skill_source_requires_identifiers() -> None:
    with pytest.raises(HTTPException) as exc_info:
        _build_uploaded_skill_source("marketplace", "weibo", None, "skill-key")

    assert exc_info.value.status_code == 400


def test_marketplace_skill_source_schema_preserves_identifiers() -> None:
    source = SkillSource(
        type="marketplace",
        provider_key="weibo",
        skill_key="owner_skill-key",
        original_skill_key="skill-key",
    )

    assert source.model_dump()["provider_key"] == "weibo"
    assert source.model_dump()["skill_key"] == "owner_skill-key"
    assert source.model_dump()["original_skill_key"] == "skill-key"
