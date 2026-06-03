# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from chat_shell.tools.deferred_input import (
    DeferredUserInputExit,
    is_deferred_user_input_result,
)


def test_detects_deferred_user_input_result_from_dict():
    assert is_deferred_user_input_result(
        {
            "__deferred_user_input__": True,
            "success": True,
            "status": "waiting_for_user_response",
        }
    )


def test_detects_deferred_user_input_result_from_json_string():
    assert is_deferred_user_input_result(
        '{"__deferred_user_input__": true, "success": true, "status": "waiting_for_user_response"}'
    )


def test_detects_deferred_user_input_result_from_content_text_blocks():
    result = [
        {
            "type": "text",
            "text": (
                '{"__deferred_user_input__": true, "success": true, '
                '"status": "waiting_for_user_response"}'
            ),
        }
    ]

    assert is_deferred_user_input_result(result)


def test_rejects_plain_success_result():
    assert not is_deferred_user_input_result({"success": True})


def test_deferred_exit_message_is_id_free():
    error = DeferredUserInputExit()
    assert str(error) == "Waiting for user input"
