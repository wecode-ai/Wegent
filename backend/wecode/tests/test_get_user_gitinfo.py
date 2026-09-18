# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for fetching and validating cloud-device Git tokens."""

import base64
import logging
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from wecode.service.get_user_gitinfo import (
    GetUserGitInfo,
    GitTokenNotConfiguredError,
    GitTokenRejectedError,
    GitTokenSourceUnavailableError,
    GitTokenValidationUnavailableError,
)

DOMAIN = "git.intra.weibo.com"
TOKEN = "glpat-cloud-device-test-token"


def _encoded_token(token: str = TOKEN) -> str:
    return base64.b64encode(token.encode("utf-8")).decode("ascii")


def _service_with_git_data(monkeypatch, git_data) -> GetUserGitInfo:
    service = GetUserGitInfo()
    monkeypatch.setattr(
        service,
        "_fetch_git_data",
        lambda username, cluster: git_data,
    )
    return service


def test_get_validated_real_git_tokens_uses_decoded_token_and_matching_domain(
    monkeypatch,
):
    """Validation must send the credential, not the domain string, to GitLab."""
    service = _service_with_git_data(monkeypatch, {DOMAIN: _encoded_token()})
    validate_token = MagicMock(
        return_value={
            "valid": True,
            "user": {"id": 7, "login": "alice", "email": "alice@example.com"},
        }
    )
    monkeypatch.setattr(
        "wecode.service.get_user_gitinfo.GitLabProvider.validate_token",
        validate_token,
    )

    result = service.get_validated_real_git_tokens("alice")

    assert result == [
        {
            "type": "gitlab",
            "git_domain": DOMAIN,
            "git_token": TOKEN,
            "git_id": "7",
            "git_login": "alice",
            "git_email": "alice@example.com",
        }
    ]
    validate_token.assert_called_once_with(token=TOKEN, git_domain=DOMAIN)


def test_get_validated_real_git_tokens_rejects_invalid_token_without_logging_it(
    monkeypatch,
    caplog,
):
    service = _service_with_git_data(monkeypatch, {DOMAIN: _encoded_token()})
    monkeypatch.setattr(
        "wecode.service.get_user_gitinfo.GitLabProvider.validate_token",
        MagicMock(return_value={"valid": False}),
    )

    with caplog.at_level(logging.WARNING), pytest.raises(GitTokenRejectedError):
        service.get_validated_real_git_tokens("alice")

    assert DOMAIN in caplog.text
    assert TOKEN not in caplog.text


def test_get_validated_real_git_tokens_reports_validation_outage(monkeypatch):
    service = _service_with_git_data(monkeypatch, {DOMAIN: _encoded_token()})
    monkeypatch.setattr(
        "wecode.service.get_user_gitinfo.GitLabProvider.validate_token",
        MagicMock(side_effect=HTTPException(status_code=502, detail="upstream failed")),
    )

    with pytest.raises(GitTokenValidationUnavailableError) as exc_info:
        service.get_validated_real_git_tokens("alice")

    assert exc_info.value.domain == DOMAIN


def test_get_validated_real_git_tokens_requires_supported_token(monkeypatch):
    service = _service_with_git_data(
        monkeypatch,
        {"unsupported.example.com": _encoded_token()},
    )

    with pytest.raises(GitTokenNotConfiguredError):
        service.get_validated_real_git_tokens("alice")


def test_get_validated_real_git_tokens_rejects_malformed_secret(monkeypatch):
    service = _service_with_git_data(monkeypatch, {DOMAIN: "not-base64!"})

    with pytest.raises(GitTokenSourceUnavailableError):
        service.get_validated_real_git_tokens("alice")


def test_login_time_token_discovery_drops_rejected_token(monkeypatch):
    """The existing login path must not persist a credential GitLab rejected."""
    service = _service_with_git_data(monkeypatch, {DOMAIN: _encoded_token()})
    validate_token = MagicMock(return_value={"valid": False})
    monkeypatch.setattr(
        "wecode.service.get_user_gitinfo.GitLabProvider.validate_token",
        validate_token,
    )

    assert service.fetch_git_tokens("alice") == []
    validate_token.assert_called_once_with(token=TOKEN, git_domain=DOMAIN)
