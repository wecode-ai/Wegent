# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_create_stateless_response_success(test_client: TestClient, test_token: str):
    with patch(
        "app.api.endpoints.adapter.model_runtime.stateless_runtime_service.complete_text",
        new=AsyncMock(return_value="hello from runtime"),
    ):
        response = test_client.post(
            "/api/model-runtime/responses",
            headers=_auth_header(test_token),
            json={
                "model": "gpt-5.4",
                "input": [{"role": "user", "content": "say hello"}],
                "stream": False,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["output_text"] == "hello from runtime"
    assert payload["model"] == "gpt-5.4"
    assert "created_at" in payload


def test_create_stateless_response_accepts_string_input(
    test_client: TestClient, test_token: str
):
    with patch(
        "app.api.endpoints.adapter.model_runtime.stateless_runtime_service.complete_text",
        new=AsyncMock(return_value="ok"),
    ) as mock_complete:
        response = test_client.post(
            "/api/model-runtime/responses",
            headers=_auth_header(test_token),
            json={
                "model": "gpt-5.4",
                "input": "direct question",
                "stream": False,
            },
        )

    assert response.status_code == 200
    first_call = mock_complete.await_args_list[0].kwargs
    assert first_call["input_data"] == "direct question"
