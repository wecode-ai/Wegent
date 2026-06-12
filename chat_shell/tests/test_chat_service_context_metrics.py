# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for final context-metrics message source resolution in ChatService."""

from chat_shell.services.chat_service import _resolve_final_context_metric_messages


def test_prefers_final_live_state_messages_when_available():
    initial_messages = [{"role": "user", "content": "start"}]
    messages_chain = [{"role": "assistant", "content": "approx"}]
    live_state_messages = [
        {"role": "user", "content": "start"},
        {"role": "assistant", "content": "guarded final"},
    ]

    resolved = _resolve_final_context_metric_messages(
        initial_messages=initial_messages,
        messages_chain=messages_chain,
        live_state_messages=live_state_messages,
    )

    assert resolved == live_state_messages
    assert resolved is not live_state_messages


def test_falls_back_to_initial_plus_messages_chain_without_live_state():
    initial_messages = [{"role": "user", "content": "start"}]
    messages_chain = [{"role": "assistant", "content": "approx"}]

    resolved = _resolve_final_context_metric_messages(
        initial_messages=initial_messages,
        messages_chain=messages_chain,
        live_state_messages=None,
    )

    assert resolved == initial_messages + messages_chain
