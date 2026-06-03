# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from chat_shell.tools.deferred_input import (
    DeferredUserInputExit,
    get_deferred_ask_id,
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


def test_extracts_ask_id_from_deferred_result():
    assert (
        get_deferred_ask_id(
            {
                "__deferred_user_input__": True,
                "success": True,
                "status": "waiting_for_user_response",
                "ask_id": "ask_123",
            }
        )
        == "ask_123"
    )


def test_rejects_plain_success_result():
    assert not is_deferred_user_input_result({"success": True})


def test_deferred_exit_message_includes_ask_id():
    error = DeferredUserInputExit("ask_123")
    assert error.ask_id == "ask_123"
    assert "ask_123" in str(error)
