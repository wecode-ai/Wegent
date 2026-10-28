# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.services.subscription.helpers import extract_result_summary
from app.services.subscription.notification_directives import (
    append_group_notification_instruction,
    parse_notification_directives,
    strip_notification_directives,
)


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("Nothing changed today.", "Nothing changed today."),
        ("Nothing changed today.\n\n", "Nothing changed today."),
        (
            "Today's report is attached.\n\n[静默]",
            "Today's report is attached.",
        ),
        ("No changes today. 【静默】", "No changes today."),
        ("No changes today. [silent]", "No changes today."),
        ("No changes today. 【silent】", "No changes today."),
        (
            "Please review the alert.\n\n[@列表:900101,900102]",
            "Please review the alert.",
        ),
        (
            "Please review the alert.\n\n【@列表:900101,900102】",
            "Please review the alert.",
        ),
        (
            "Please review the alert.\n\n【@列表:1234，1235】",
            "Please review the alert.",
        ),
        (
            "Please review the alert.\n\n[mention: 900101, 900102]",
            "Please review the alert.",
        ),
        (
            "Please review the alert.\n\n【mention:900101,900102】",
            "Please review the alert.",
        ),
        (
            "Please review the alert.\n\n[静默] [@列表:900101]",
            "Please review the alert.",
        ),
    ],
)
def test_parse_notification_directives_strips_trailing_controls(
    message: str, expected: str
) -> None:
    directives = parse_notification_directives(message)

    assert directives.content == expected


def test_parse_notification_directives_extracts_silent_and_mentions() -> None:
    directives = parse_notification_directives(
        "Alert needs attention.\n\n[静默] [@列表:900101, 900102, 900101]"
    )

    assert directives.silent is True
    assert directives.mention_staff_ids == ("900101", "900102")
    assert directives.content == "Alert needs attention."


def test_parse_notification_directives_accepts_brackets_and_comma_variants() -> None:
    square = parse_notification_directives(
        "Alert needs attention.\n\n[@列表:1234，1235]"
    )
    fullwidth = parse_notification_directives(
        "Alert needs attention.\n\n【mention:1234, 1235】"
    )

    assert square.mention_staff_ids == ("1234", "1235")
    assert fullwidth.mention_staff_ids == ("1234", "1235")


def test_parse_notification_directives_accepts_colon_variants() -> None:
    fullwidth_colon = parse_notification_directives(
        "Alert needs attention.\n\n【@列表：900101】"
    )
    ascii_colon = parse_notification_directives(
        "Alert needs attention.\n\n[@列表:900101]"
    )

    assert fullwidth_colon.mention_staff_ids == ("900101",)
    assert ascii_colon.mention_staff_ids == ("900101",)


@pytest.mark.parametrize(
    "shell_type",
    ["Chat", "ClaudeCode", "Codex", "Agno", "Dify"],
)
def test_parse_notification_directives_works_for_shell_results(
    shell_type: str,
) -> None:
    result = {
        "value": "测试\n【@列表：900101】",
        "executor_session": {"agent": shell_type},
    }

    directives = parse_notification_directives(extract_result_summary(result))

    assert directives.content == "测试"
    assert directives.mention_staff_ids == ("900101",)


def test_parse_notification_directives_keeps_body_mentions() -> None:
    message = "Please ask @900101 to review.\nThis is still the body."

    directives = parse_notification_directives(message)

    assert directives.content == message
    assert directives.silent is False
    assert directives.mention_staff_ids == ()


def test_parse_notification_directives_drops_mention_display_names() -> None:
    directives = parse_notification_directives(
        "Alert needs attention.\n\n[@列表:900101：张三,900102:李四]"
    )

    assert directives.mention_staff_ids == ("900101", "900102")


@pytest.mark.parametrize(
    "message",
    [
        "Nothing changed today.\n\n【@列表：】",
        "Nothing changed today.\n\n[@列表:]",
        "Nothing changed today.\n\n【@列表：张三】",
        "Nothing changed today.\n\n【mention:】",
    ],
)
def test_parse_notification_directives_drops_empty_or_non_staff_mentions(
    message: str,
) -> None:
    """Empty or malformed mention controls must not create bogus staff IDs."""
    directives = parse_notification_directives(message)

    assert directives.content == "Nothing changed today."
    assert directives.mention_staff_ids == ()


@pytest.mark.parametrize(
    "message",
    [
        "Nothing changed today.\n静默",
        "Nothing changed today. (静默)",
        "Please ask @900101 to review.",
        "Please ask @900101 @900102",
    ],
)
def test_parse_notification_directives_requires_bracketed_controls(
    message: str,
) -> None:
    directives = parse_notification_directives(message)

    assert directives.content == message
    assert directives.silent is False
    assert directives.mention_staff_ids == ()


def test_parse_notification_directives_ignores_controls_inside_body() -> None:
    message = "The previous run printed [静默] in its output."

    assert strip_notification_directives(message) == message


def test_append_group_notification_instruction_requires_bound_group() -> None:
    prompt = "Check the service."

    assert append_group_notification_instruction(prompt, {}) == prompt
    assert (
        append_group_notification_instruction(
            prompt,
            {
                "_internal": {
                    "notification_channel_bindings": {
                        "1": {"bind_group": True, "group_conversation_id": ""}
                    }
                }
            },
        )
        == prompt
    )

    appended = append_group_notification_instruction(
        prompt,
        {
            "_internal": {
                "notification_channel_bindings": {
                    "1": {
                        "bind_group": True,
                        "group_conversation_id": "conversation-1",
                    }
                }
            }
        },
    )

    assert appended.startswith("Check the service.")
    assert "【静默】" in appended
    assert "【@列表:1234,1235】" in appended
