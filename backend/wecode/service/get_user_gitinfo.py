# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Fetch and validate Git credentials supplied by the internal secret service."""

import base64
import binascii
import logging
from typing import Any

import httpx

from app.repository.gitlab_provider import GitLabProvider


class GitTokenProvisioningError(RuntimeError):
    """Base error for cloud-device Git credential provisioning."""


class GitTokenSourceUnavailableError(GitTokenProvisioningError):
    """The internal secret service did not return usable data."""


class GitTokenNotConfiguredError(GitTokenProvisioningError):
    """No supported Git token is configured for the user."""


class GitTokenRejectedError(GitTokenProvisioningError):
    """GitLab rejected one configured token."""

    def __init__(self, domain: str):
        super().__init__(f"Git token rejected for domain {domain}")
        self.domain = domain


class GitTokenValidationUnavailableError(GitTokenProvisioningError):
    """GitLab could not be reached to validate one configured token."""

    def __init__(self, domain: str):
        super().__init__(f"Git token validation unavailable for domain {domain}")
        self.domain = domain


class GetUserGitInfo:
    """Fetch and validate user Git tokens from the internal secret service."""

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.git_token_api_url = (
            "http://paas.intra.weibo.com/2/appnest/api/code-server-new/secret/get"
        )
        self.git_token_auth = (
            "Basic "
            "L3BhYXMvd2ItcGxhdC1wYWFzL3diLXBsYXQtcGFhcy1hZG1pbiN3ZWdlbnQ6"
            "b2JOd0dkS1J4ZUxRRHk4aGQ1Z3B3WGpvMG5nQ05xV3E="
        )
        self.target_keys = [
            "git.intra.weibo.com",
            "git.staff.sina.com.cn",
            "gitlab.weibo.cn",
        ]

    def _fetch_git_data(self, username: str, cluster: str) -> dict[str, Any]:
        """Return the secret-service payload or raise a sanitized error."""
        try:
            with httpx.Client() as client:
                response = client.get(
                    self.git_token_api_url,
                    params={"user": username, "cluster": cluster},
                    headers={"Authorization": self.git_token_auth},
                    timeout=10,
                )
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPError as error:
            status_code = getattr(getattr(error, "response", None), "status_code", None)
            self.logger.warning(
                "Git token source request failed: username=%s, status=%s, "
                "error_type=%s",
                username,
                status_code if status_code is not None else "none",
                type(error).__name__,
            )
            raise GitTokenSourceUnavailableError from error
        except (TypeError, ValueError) as error:
            self.logger.warning(
                "Git token source response was not valid JSON: username=%s, "
                "error_type=%s",
                username,
                type(error).__name__,
            )
            raise GitTokenSourceUnavailableError from error

        response_data = data.get("data") if isinstance(data, dict) else None
        git_data = (
            response_data.get("data") if isinstance(response_data, dict) else None
        )
        if (
            not isinstance(data, dict)
            or data.get("code") != 0
            or not isinstance(git_data, dict)
        ):
            self.logger.warning(
                "Git token source returned an invalid payload: username=%s, code=%s",
                username,
                data.get("code") if isinstance(data, dict) else "unknown",
            )
            raise GitTokenSourceUnavailableError
        return git_data

    def _decode_git_tokens(
        self,
        git_data: dict[str, Any],
        *,
        strict: bool,
    ) -> list[dict[str, Any]]:
        """Decode supported tokens without ever logging their values."""
        git_tokens: list[dict[str, Any]] = []
        for domain in self.target_keys:
            encoded_token = git_data.get(domain)
            if not encoded_token:
                continue

            try:
                decoded_token = (
                    base64.b64decode(encoded_token, validate=True)
                    .decode("utf-8")
                    .strip()
                )
            except (binascii.Error, TypeError, ValueError, UnicodeDecodeError) as error:
                self.logger.warning(
                    "Git token could not be decoded: domain=%s, error_type=%s",
                    domain,
                    type(error).__name__,
                )
                if strict:
                    raise GitTokenSourceUnavailableError from error
                continue

            if decoded_token:
                git_tokens.append(
                    {
                        "type": "gitlab",
                        "git_domain": domain,
                        "git_token": decoded_token,
                    }
                )
        return git_tokens

    def fetch_git_tokens(
        self, username: str, cluster: str = "cn"
    ) -> list[dict[str, Any]]:
        """Fetch tokens and retain only credentials accepted by GitLab."""
        try:
            git_data = self._fetch_git_data(username, cluster)
        except GitTokenSourceUnavailableError:
            return []
        return self._process_git_tokens(git_data)

    def _process_git_tokens(self, git_data: dict[str, Any]) -> list[dict[str, Any]]:
        """Decode and validate tokens for login-time Git account discovery."""
        validated_git_info: list[dict[str, Any]] = []
        for git_info_item in self._decode_git_tokens(git_data, strict=False):
            domain = git_info_item["git_domain"]
            try:
                if self._validate_git_token(git_info_item):
                    validated_git_info.append(git_info_item)
                else:
                    self.logger.warning(
                        "Git token validation failed: domain=%s",
                        domain,
                    )
            except Exception as error:
                self.logger.warning(
                    "Git token validation could not complete: domain=%s, "
                    "error_type=%s",
                    domain,
                    type(error).__name__,
                )
        return validated_git_info

    def _validate_git_token(self, git_info_item: dict[str, Any]) -> bool:
        """Validate the actual token and enrich accepted account metadata."""
        validation_result = GitLabProvider().validate_token(
            token=git_info_item["git_token"],
            git_domain=git_info_item["git_domain"],
        )
        if not validation_result.get("valid"):
            return False

        user_data = validation_result.get("user", {})
        git_info_item.update(
            {
                "git_id": str(user_data.get("id", "")),
                "git_login": user_data.get("login", ""),
                "git_email": user_data.get("email", ""),
            }
        )
        return True

    def get_and_validate_git_info(
        self, username: str, cluster: str = "cn"
    ) -> list[dict[str, Any]]:
        """Fetch validated Git account metadata without blocking login."""
        self.logger.info("Start fetching user Git token: username=%s", username)
        git_info = self.fetch_git_tokens(username, cluster)
        self.logger.info(
            "Completed fetching and validating Git tokens: username=%s, count=%s",
            username,
            len(git_info),
        )
        return git_info

    def get_real_git_tokens(
        self, username: str, cluster: str = "cn"
    ) -> list[dict[str, Any]]:
        """Fetch decoded tokens for existing best-effort callers."""
        try:
            git_data = self._fetch_git_data(username, cluster)
        except GitTokenSourceUnavailableError:
            return []
        return self._decode_git_tokens(git_data, strict=False)

    def get_validated_real_git_tokens(
        self, username: str, cluster: str = "cn"
    ) -> list[dict[str, Any]]:
        """Return enriched tokens after every configured domain accepts its token."""
        git_data = self._fetch_git_data(username, cluster)
        git_tokens = self._decode_git_tokens(git_data, strict=True)
        if not git_tokens:
            raise GitTokenNotConfiguredError

        validated_git_tokens: list[dict[str, Any]] = []
        for git_info_item in git_tokens:
            domain = git_info_item["git_domain"]
            try:
                validation_item = git_info_item.copy()
                valid = self._validate_git_token(validation_item)
            except Exception as error:
                self.logger.warning(
                    "Cloud-device Git token validation unavailable: username=%s, "
                    "domain=%s, error_type=%s",
                    username,
                    domain,
                    type(error).__name__,
                )
                raise GitTokenValidationUnavailableError(domain) from error

            if not valid:
                self.logger.warning(
                    "Cloud-device Git token was rejected: username=%s, domain=%s",
                    username,
                    domain,
                )
                raise GitTokenRejectedError(domain)
            validated_git_tokens.append(validation_item)

        self.logger.info(
            "Cloud-device Git tokens validated: username=%s, domains=%s, count=%s",
            username,
            ",".join(item["git_domain"] for item in validated_git_tokens),
            len(validated_git_tokens),
        )
        return validated_git_tokens


# Global instance
get_user_gitinfo = GetUserGitInfo()
