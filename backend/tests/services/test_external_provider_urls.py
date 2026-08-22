# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External provider attachment URL derivation for self-hosted instances."""

from unittest.mock import patch

from app.services.loop_items.external_provider import external_loop_item_provider


def test_gitlab_attachment_url_uses_api_base_web_root():
    provider = external_loop_item_provider
    with patch.object(
        provider,
        "_config",
        return_value=(
            {"api_base": "https://gitlab.example.com:8443/gitlab/api/v4"},
            "token",
        ),
    ):
        assert (
            provider._absolute_gitlab_url(object(), "/uploads/abc.png")
            == "https://gitlab.example.com:8443/gitlab/uploads/abc.png"
        )


def test_gitlab_attachment_url_falls_back_to_domain_without_api_base():
    provider = external_loop_item_provider
    with patch.object(
        provider,
        "_config",
        return_value=({"domain": "gitlab.example.com"}, "token"),
    ):
        assert (
            provider._absolute_gitlab_url(object(), "/uploads/abc.png")
            == "https://gitlab.example.com/uploads/abc.png"
        )
