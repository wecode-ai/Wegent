# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for multimodal prompt utility functions."""

import asyncio
import base64
import os
import tempfile

import pytest

from executor.agents.claude_code.multimodal_prompt import (
    _parse_data_uri,
    append_text_to_vision_prompt,
    convert_openai_to_anthropic_content,
    create_multimodal_query,
    is_vision_prompt,
    save_vision_images,
)

# --- is_vision_prompt ---


class TestIsVisionPrompt:
    def test_string_prompt_returns_false(self):
        assert is_vision_prompt("hello world") is False

    def test_empty_list_returns_false(self):
        assert is_vision_prompt([]) is False

    def test_text_only_list_returns_false(self):
        blocks = [{"type": "input_text", "text": "hello"}]
        assert is_vision_prompt(blocks) is False

    def test_list_with_input_image_returns_true(self):
        blocks = [
            {"type": "input_text", "text": "describe this"},
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
        ]
        assert is_vision_prompt(blocks) is True

    def test_list_with_anthropic_image_returns_true(self):
        blocks = [
            {"type": "text", "text": "describe this"},
            {"type": "image", "source": {"type": "base64", "data": "abc"}},
        ]
        assert is_vision_prompt(blocks) is True

    def test_non_list_types_return_false(self):
        assert is_vision_prompt(42) is False
        assert is_vision_prompt(None) is False
        assert is_vision_prompt({"type": "input_image"}) is False


# --- append_text_to_vision_prompt ---


class TestAppendTextToVisionPrompt:
    def test_append_to_existing_text_block(self):
        prompt = [
            {"type": "input_text", "text": "original"},
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
        ]
        result = append_text_to_vision_prompt(prompt, "extra info")
        assert result[0]["text"] == "original\nextra info"
        # Original not mutated
        assert prompt[0]["text"] == "original"

    def test_prepend_to_existing_text_block(self):
        prompt = [
            {"type": "input_text", "text": "original"},
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
        ]
        result = append_text_to_vision_prompt(prompt, "prefix", prepend=True)
        assert result[0]["text"] == "prefix\n\noriginal"

    def test_append_creates_new_block_when_no_text_block(self):
        prompt = [
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
        ]
        result = append_text_to_vision_prompt(prompt, "new text")
        assert len(result) == 2
        assert result[1] == {"type": "input_text", "text": "new text"}

    def test_prepend_creates_new_block_when_no_text_block(self):
        prompt = [
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
        ]
        result = append_text_to_vision_prompt(prompt, "new text", prepend=True)
        assert len(result) == 2
        assert result[0] == {"type": "input_text", "text": "new text"}

    def test_does_not_mutate_original(self):
        prompt = [
            {"type": "input_text", "text": "original"},
        ]
        append_text_to_vision_prompt(prompt, "added")
        assert prompt[0]["text"] == "original"


# --- convert_openai_to_anthropic_content ---


class TestConvertOpenaiToAnthropicContent:
    def test_converts_input_text(self):
        blocks = [{"type": "input_text", "text": "hello"}]
        result = convert_openai_to_anthropic_content(blocks)
        assert result == [{"type": "text", "text": "hello"}]

    def test_converts_input_image_data_uri(self):
        blocks = [
            {"type": "input_image", "image_url": "data:image/jpeg;base64,/9j/4AAQ"}
        ]
        result = convert_openai_to_anthropic_content(blocks)
        assert len(result) == 1
        assert result[0]["type"] == "image"
        assert result[0]["source"]["type"] == "base64"
        assert result[0]["source"]["media_type"] == "image/jpeg"
        assert result[0]["source"]["data"] == "/9j/4AAQ"

    def test_converts_mixed_content(self):
        blocks = [
            {"type": "input_text", "text": "What is this?"},
            {"type": "input_image", "image_url": "data:image/png;base64,iVBOR"},
        ]
        result = convert_openai_to_anthropic_content(blocks)
        assert len(result) == 2
        assert result[0] == {"type": "text", "text": "What is this?"}
        assert result[1]["type"] == "image"
        assert result[1]["source"]["media_type"] == "image/png"

    def test_passes_through_unknown_block_types(self):
        blocks = [{"type": "custom", "data": "foo"}]
        result = convert_openai_to_anthropic_content(blocks)
        assert result == blocks


# --- create_multimodal_query ---


class TestCreateMultimodalQuery:
    def test_yields_single_user_message(self):
        content = [{"type": "text", "text": "hello"}]

        async def run():
            messages = []
            async for msg in create_multimodal_query(content):
                messages.append(msg)
            return messages

        messages = asyncio.get_event_loop().run_until_complete(run())
        assert len(messages) == 1
        assert messages[0]["type"] == "user"
        assert messages[0]["message"]["role"] == "user"
        assert messages[0]["message"]["content"] == content

    def test_yields_multimodal_content(self):
        content = [
            {"type": "text", "text": "describe"},
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": "abc",
                },
            },
        ]

        async def run():
            messages = []
            async for msg in create_multimodal_query(content):
                messages.append(msg)
            return messages

        messages = asyncio.get_event_loop().run_until_complete(run())
        assert messages[0]["message"]["content"] == content


# --- _parse_data_uri ---


class TestParseDataUri:
    def test_parses_valid_data_uri(self):
        media_type, data = _parse_data_uri("data:image/png;base64,iVBOR")
        assert media_type == "image/png"
        assert data == "iVBOR"

    def test_parses_jpeg_data_uri(self):
        media_type, data = _parse_data_uri("data:image/jpeg;base64,/9j/4AAQ")
        assert media_type == "image/jpeg"
        assert data == "/9j/4AAQ"

    def test_invalid_uri_returns_defaults(self):
        media_type, data = _parse_data_uri("not-a-data-uri")
        assert media_type == "image/png"
        assert data == "not-a-data-uri"

    def test_empty_string_returns_defaults(self):
        media_type, data = _parse_data_uri("")
        assert media_type == "image/png"
        assert data == ""


# --- save_vision_images ---


class TestSaveVisionImages:
    def test_saves_png_image(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "executor.config.config.WEGENT_EXECUTOR_HOME",
            str(tmp_path),
        )
        png_data = base64.b64encode(b"\x89PNG\r\n\x1a\nfakedata").decode()
        prompt = [
            {"type": "input_text", "text": "describe this"},
            {"type": "input_image", "image_url": f"data:image/png;base64,{png_data}"},
        ]
        paths = save_vision_images(prompt, task_id="42")
        assert len(paths) == 1
        assert paths[0].endswith(".png")
        assert os.path.exists(paths[0])
        # Path format: <home>/docs/pics/YYYYMM/42_<uuid>.png
        assert "docs/pics/" in paths[0]
        assert "/42_" in paths[0]
        with open(paths[0], "rb") as f:
            assert f.read() == base64.b64decode(png_data)

    def test_saves_multiple_images(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "executor.config.config.WEGENT_EXECUTOR_HOME",
            str(tmp_path),
        )
        img = base64.b64encode(b"fakeimg").decode()
        prompt = [
            {"type": "input_image", "image_url": f"data:image/jpeg;base64,{img}"},
            {"type": "input_image", "image_url": f"data:image/png;base64,{img}"},
        ]
        paths = save_vision_images(prompt, task_id="99")
        assert len(paths) == 2
        assert paths[0].endswith(".jpg")
        assert paths[1].endswith(".png")

    def test_skips_non_image_blocks(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "executor.config.config.WEGENT_EXECUTOR_HOME",
            str(tmp_path),
        )
        prompt = [{"type": "input_text", "text": "hello"}]
        paths = save_vision_images(prompt)
        assert paths == []

    def test_no_task_id_omits_prefix(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            "executor.config.config.WEGENT_EXECUTOR_HOME",
            str(tmp_path),
        )
        img = base64.b64encode(b"data").decode()
        prompt = [
            {"type": "input_image", "image_url": f"data:image/png;base64,{img}"},
        ]
        paths = save_vision_images(prompt)
        assert len(paths) == 1
        assert "docs/pics/" in paths[0]
        # No task_id prefix — filename is just <uuid>.png
        filename = os.path.basename(paths[0])
        assert "_" not in filename.split(".")[0]  # no underscore prefix
        assert os.path.exists(paths[0])
