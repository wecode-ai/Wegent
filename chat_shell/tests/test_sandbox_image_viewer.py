# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for image serialization helpers."""

from chat_shell.agents.graph_builder import _strip_image_data_for_storage


class TestStripImageDataForStorage:
    def test_replaces_image_url_blocks_with_placeholder(self):
        blocks = [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ]
        result = _strip_image_data_for_storage(blocks)
        assert result == [{"type": "text", "text": "[image content - not stored]"}]

    def test_preserves_non_image_blocks(self):
        blocks = [
            {"type": "text", "text": "hello"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            {"type": "text", "text": "world"},
        ]
        result = _strip_image_data_for_storage(blocks)
        assert result[0] == {"type": "text", "text": "hello"}
        assert result[1] == {"type": "text", "text": "[image content - not stored]"}
        assert result[2] == {"type": "text", "text": "world"}

    def test_empty_list(self):
        assert _strip_image_data_for_storage([]) == []

    def test_non_dict_items_pass_through(self):
        blocks = ["plain_string", {"type": "text", "text": "ok"}]
        result = _strip_image_data_for_storage(blocks)
        assert result == blocks
