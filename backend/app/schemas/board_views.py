# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Saved board projections stored in project metadata, independent of statuses."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SortRule = Literal[
    "priority-desc",
    "priority-asc",
    "created-desc",
    "created-asc",
    "updated-desc",
    "updated-asc",
]


class BoardViewColumn(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1, max_length=128)
    type: Literal["status", "tag"]
    value: str = Field(min_length=1, max_length=80)


class BoardViewFilter(BaseModel):
    model_config = ConfigDict(extra="allow")

    tags: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(
        default_factory=list, max_length=50
    )
    match: Literal["any", "all"] = "all"


class BoardView(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=100)
    columns: list[BoardViewColumn] = Field(min_length=1, max_length=50)
    filter: BoardViewFilter = Field(default_factory=BoardViewFilter)
    sorts: dict[str, list[SortRule]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_columns(self) -> "BoardView":
        ids = [column.id for column in self.columns]
        bindings = [(column.type, column.value) for column in self.columns]
        if len(set(ids)) != len(ids) or len(set(bindings)) != len(bindings):
            raise ValueError("board column ids and bindings must be unique")
        if not self.name.strip():
            raise ValueError("board view name must not be blank")
        if any(
            not column.id.strip() or not column.value.strip() for column in self.columns
        ):
            raise ValueError("board column ids and values must not be blank")
        if any(not tag.strip() for tag in self.filter.tags):
            raise ValueError("board filter tags must not be blank")
        for rules in self.sorts.values():
            if len({rule.split("-")[0] for rule in rules}) != len(rules):
                raise ValueError("board sort fields must be unique")
        return self


class BoardViews(BaseModel):
    model_config = ConfigDict(extra="allow")

    schema_version: Literal[1] = 1
    default_view_id: str = Field(default="default", min_length=1, max_length=128)
    views: list[BoardView] = Field(default_factory=list, max_length=30)

    @model_validator(mode="after")
    def validate_views(self) -> "BoardViews":
        ids = [view.id for view in self.views]
        if (
            len(set(ids)) != len(ids)
            or "default" in ids
            or any(not value.strip() for value in ids)
        ):
            raise ValueError("board view ids must be unique and not reserved")
        if self.default_view_id != "default" and self.default_view_id not in ids:
            raise ValueError("default board view must reference an existing view")
        return self
