# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import BaseModel, ValidationError

from app.schemas.board_views import BoardViewColumn, BoardViewFilter, BoardViews
from app.schemas.cloud_project import CloudProjectUpdate
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.schemas.tagging import normalize_tags


@pytest.mark.parametrize(
    "model,required",
    [
        (LoopItemCreate, {"title": "Issue"}),
        (LoopItemUpdate, {"version": 1}),
        (CloudProjectUpdate, {"version": 1}),
    ],
)
def test_tag_count_rejects_overflow_after_normalization(
    model: type[BaseModel], required: dict
) -> None:
    tags = [f"tag-{index}" for index in range(20)]
    assert model.model_validate({**required, "tags": tags[:19]}).tags == tags[:19]
    assert model.model_validate({**required, "tags": tags}).tags == tags
    assert (
        model.model_validate({**required, "tags": [*tags, " tag-0 ", ""]}).tags == tags
    )
    with pytest.raises(ValidationError):
        model.model_validate({**required, "tags": [*tags, "overflow"]})
    assert normalize_tags([*tags, "overflow"]) == [*tags, "overflow"]


@pytest.mark.parametrize("value", [" tag", "tag ", "\ttag", "tag\n", "\u3000tag"])
def test_tag_references_reject_noncanonical_names(value: str) -> None:
    assert LoopItemCreate(title="Issue", tags=[value]).tags == ["tag"]
    with pytest.raises(ValidationError):
        BoardViewColumn(id="tag", type="tag", value=value)
    with pytest.raises(ValidationError):
        BoardViewFilter(tags=[value])


@pytest.mark.parametrize("character", ["a", "标", "😀"])
def test_tag_lengths_reject_invalid_writes_and_preserve_historical_reads(
    character: str,
) -> None:
    tag = character * 32
    for model, required in [
        (LoopItemCreate, {"title": "Issue"}),
        (LoopItemUpdate, {"version": 1}),
        (CloudProjectUpdate, {"version": 1}),
    ]:
        assert model.model_validate({**required, "tags": [tag]}).tags == [tag]
        with pytest.raises(ValidationError):
            model.model_validate({**required, "tags": [tag + character]})
    assert normalize_tags([tag + character]) == [tag + character]


@pytest.mark.parametrize(
    "config",
    [
        {"schema_version": 2, "views": []},
        {"schema_version": 1, "views": [], "default_view_id": "missing"},
        {"schema_version": 1, "views": [], "default_view_id": None},
        {
            "schema_version": 1,
            "views": [{"id": "default", "name": "Reserved", "columns": []}],
        },
        {
            "schema_version": 1,
            "views": [
                {
                    "id": "one",
                    "name": "Duplicate",
                    "columns": [
                        {"id": "a", "type": "tag", "value": "same"},
                        {"id": "b", "type": "tag", "value": "same"},
                    ],
                }
            ],
        },
        {
            "schema_version": 1,
            "views": [
                {
                    "id": "one",
                    "name": "Invalid sort",
                    "columns": [
                        {"id": "a", "type": "tag", "value": "tag"},
                    ],
                    "sorts": {"a": ["created-asc", "created-desc"]},
                }
            ],
        },
    ],
)
def test_rejects_unsupported_or_ambiguous_views(config: dict) -> None:
    with pytest.raises(ValidationError):
        BoardViews.model_validate(config)


def test_accepts_historical_and_explicit_defaults() -> None:
    assert BoardViews.model_validate({"views": []}).default_view_id == "default"
    config = {
        "default_view_id": "mixed",
        "views": [
            {
                "id": "mixed",
                "name": "Mixed",
                "columns": [{"id": "a", "type": "tag", "value": "bug"}],
            }
        ],
    }
    assert BoardViews.model_validate(config).default_view_id == "mixed"


def test_backlog_is_unique_even_when_lane_names_differ() -> None:
    config = {
        "views": [
            {
                "id": "stages",
                "name": "Stages",
                "columns": [
                    {"id": "backlog", "type": "unmatched", "value": "Backlog"},
                    {"id": "design", "type": "tag", "value": "design"},
                ],
            }
        ],
    }
    parsed = BoardViews.model_validate(config)
    assert parsed.views[0].columns[0].type == "unmatched"
    assert parsed.views[0].columns[0].value == "Backlog"
    config["views"][0]["columns"].append(
        {"id": "other", "type": "unmatched", "value": "Other"}
    )
    with pytest.raises(ValidationError):
        BoardViews.model_validate(config)
