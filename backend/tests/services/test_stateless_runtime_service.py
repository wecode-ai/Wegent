# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from app.services.model_runtime.stateless_runtime_service import (
    normalize_input_messages,
    serialize_stream_event,
)


def test_normalize_input_messages_wraps_string_as_user_message():
    result = normalize_input_messages("hello runtime")

    assert result == [{"role": "user", "content": "hello runtime"}]


def test_serialize_stream_event_prefers_model_dump_payload():
    event = SimpleNamespace(
        model_dump=lambda: {"type": "response.completed", "done": True}
    )

    result = serialize_stream_event(event)

    assert result == 'data: {"type": "response.completed", "done": true}\n\n'
