# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.quick_launch import (
    QuickLaunchFunctionConfig,
    normalize_quick_phrases,
)


def test_normalize_quick_phrases_trims_blanks_and_limits_count():
    phrases = normalize_quick_phrases(
        ["  帮我创建一个 xxx 的 PPT  ", "", "  ", "把这份大纲整理成 PPT"]
    )

    assert phrases == ["帮我创建一个 xxx 的 PPT", "把这份大纲整理成 PPT"]


def test_quick_launch_function_rejects_more_than_six_phrases():
    with pytest.raises(ValidationError):
        QuickLaunchFunctionConfig(
            id="create_ppt",
            title="创建 PPT",
            team_id=1,
            quick_phrases=[f"phrase {index}" for index in range(7)],
        )
