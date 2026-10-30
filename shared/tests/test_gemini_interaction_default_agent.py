# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import httpx
import pytest

from shared.clients.gemini_interaction import GeminiInteractionClient

# deep-research-pro-preview-12-2025 is scheduled to shut down on 2026-10-23.
RETIRED_AGENT = "deep-research-pro-preview-12-2025"
CURRENT_AGENT = "deep-research-preview-04-2026"


@pytest.mark.asyncio
async def test_create_interaction_defaults_to_the_current_deep_research_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: dict = {}

    async def fake_post(self, url, json=None, headers=None, **kwargs):
        sent["url"] = url
        sent["json"] = json
        return httpx.Response(
            200,
            json={"id": "interaction-1", "status": "in_progress"},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = GeminiInteractionClient(base_url="https://example.test", api_key="key")
    result = await client.create_interaction("What is new in quantum computing?")

    assert result["id"] == "interaction-1"
    assert sent["url"] == "https://example.test/v1beta/interactions"
    assert sent["json"]["agent"] == CURRENT_AGENT
    assert sent["json"]["agent"] != RETIRED_AGENT
    assert sent["json"]["background"] is True
