# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.quick_launch import (
    QuickLaunchFunctionConfig,
    QuickLaunchInputPreset,
    normalize_quick_phrases,
)


def test_normalize_quick_phrases_trims_blanks_and_limits_count():
    phrases = normalize_quick_phrases(
        [
            "  帮我创建一个 xxx 的 PPT  ",
            "",
            "  ",
            "把这份大纲整理成 PPT",
            "phrase 3",
            "phrase 4",
            "phrase 5",
            "phrase 6",
            "phrase 7",
        ]
    )

    assert phrases == [
        "帮我创建一个 xxx 的 PPT",
        "把这份大纲整理成 PPT",
        "phrase 3",
        "phrase 4",
        "phrase 5",
        "phrase 6",
    ]


def test_normalize_quick_phrases_rejects_non_string_items():
    with pytest.raises(ValueError, match=r"quick_phrases\[1\] must be a string"):
        normalize_quick_phrases(["valid", {"bad": "item"}])


def test_quick_launch_function_truncates_migrated_phrases_to_six_presets():
    config = QuickLaunchFunctionConfig(
        id="create_ppt",
        title="创建 PPT",
        team_id=1,
        quick_phrases=[f"phrase {index}" for index in range(7)],
    )

    assert [preset.prompt for preset in config.input_presets] == [
        "phrase 0",
        "phrase 1",
        "phrase 2",
        "phrase 3",
        "phrase 4",
        "phrase 5",
    ]


def test_quick_launch_function_migrates_phrases_to_input_presets():
    config = QuickLaunchFunctionConfig(
        id="create_ppt",
        title="创建 PPT",
        team_id=1,
        quick_phrases=["  帮我创建一个 xxx 的 PPT  ", ""],
    )

    assert len(config.input_presets) == 1
    assert config.input_presets[0].id == "preset_1"
    assert config.input_presets[0].title == "帮我创建一个 xxx 的 PPT"
    assert config.input_presets[0].prompt == "帮我创建一个 xxx 的 PPT"


def test_input_preset_normalizes_prompt_and_options():
    preset = QuickLaunchInputPreset(
        id=" review ",
        title=" Review ",
        prompt="  Review this change  ",
        source_attachment_ids=[10, 20, 10],
        options={
            "enable_deep_thinking": False,
            "enable_clarification": True,
            "force_override": True,
            "selected_skill_names": [" code-review ", "", "code-review", "tests"],
        },
    )

    assert preset.id == "review"
    assert preset.title == "Review"
    assert preset.prompt == "Review this change"
    assert preset.options.enable_deep_thinking is False
    assert preset.options.enable_clarification is True
    assert preset.options.force_override is True
    assert preset.options.selected_skill_names == ["code-review", "tests"]
    assert preset.source_attachment_ids == [10, 20]


def test_input_preset_rejects_invalid_source_attachment_ids():
    with pytest.raises(ValidationError):
        QuickLaunchInputPreset(
            id="review",
            title="Review",
            source_attachment_ids=[1, 0],
        )


def test_quick_launch_function_rejects_more_than_six_input_presets():
    with pytest.raises(ValidationError):
        QuickLaunchFunctionConfig(
            id="create_ppt",
            title="创建 PPT",
            team_id=1,
            input_presets=[
                {"id": f"preset_{index}", "title": f"Preset {index}"}
                for index in range(7)
            ],
        )
