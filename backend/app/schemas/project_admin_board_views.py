# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Strict tool inputs for the canonical saved-view persistence format."""

from pydantic import ConfigDict, Field

from app.schemas.board_views import (
    BoardView,
    BoardViewColumn,
    BoardViewFilter,
    BoardViews,
)


class ProjectAdminBoardColumn(BoardViewColumn):
    model_config = ConfigDict(extra="forbid")


class ProjectAdminBoardFilter(BoardViewFilter):
    model_config = ConfigDict(extra="forbid")

    needs_my_input: bool = False


class ProjectAdminBoardView(BoardView):
    model_config = ConfigDict(extra="forbid")

    columns: list[ProjectAdminBoardColumn] = Field(min_length=1, max_length=50)
    filter: ProjectAdminBoardFilter = Field(default_factory=ProjectAdminBoardFilter)


class ProjectAdminBoardViews(BoardViews):
    model_config = ConfigDict(extra="forbid")

    views: list[ProjectAdminBoardView] = Field(default_factory=list, max_length=30)
