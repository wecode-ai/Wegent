# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from app.services.attachment.public_link import verify_public_attachment_token
from app.services.execution.agents.image.download_url import (
    IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS,
    refresh_image_result_download_urls,
    refresh_task_image_download_urls,
)


def test_refresh_task_image_download_urls_supports_stored_tasks() -> None:
    stored_result = {
        "blocks": [
            {
                "type": "image",
                "image_attachment_ids": [96],
                "image_urls": ["/api/attachments/96/download"],
            }
        ]
    }
    task_dict = {
        "result": stored_result,
        "subtasks": [{"result": stored_result}],
    }

    with patch(
        "app.services.execution.agents.image.download_url."
        "settings.WEGENT_BACKEND_PUBLIC_URL",
        "https://backend.example",
    ):
        refresh_task_image_download_urls(task_dict)

    for result in (task_dict["result"], task_dict["subtasks"][0]["result"]):
        block = result["blocks"][0]
        download_url = block["image_download_urls"][0]
        parsed_url = urlparse(download_url)
        token = parse_qs(parsed_url.query)["token"][0]
        payload = verify_public_attachment_token(token)

        assert parsed_url.scheme == "https"
        assert parsed_url.netloc == "backend.example"
        assert parsed_url.path == "/api/attachments/download/shared"
        assert payload["attachment_id"] == 96
        assert payload["exp"] - payload["iat"] == IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS
        assert (
            block["image_download_url_expires_in_seconds"]
            == IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS
        )

    assert "image_download_urls" not in stored_result["blocks"][0]


def test_refresh_image_result_download_urls_reuses_non_image_result() -> None:
    result = {"blocks": [{"type": "text", "content": "hello"}]}

    assert refresh_image_result_download_urls(result) is result
