# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

from app.api.endpoints.adapter.models import _test_llm_connection


@patch("openai.OpenAI")
def test_gpt_image_connection_retrieves_model(mock_openai: MagicMock) -> None:
    client = mock_openai.return_value

    result = _test_llm_connection(
        provider_type="gpt-image",
        model_id="gpt-image-2",
        api_key="test-key",
        base_url=None,
        custom_headers={"X-Test": "value"},
        model_category_type="image",
    )

    mock_openai.assert_called_once_with(
        api_key="test-key",
        base_url=None,
        default_headers={"X-Test": "value"},
    )
    client.models.retrieve.assert_called_once_with("gpt-image-2")
    assert result["success"] is True
