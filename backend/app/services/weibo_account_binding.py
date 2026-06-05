# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo account binding service."""

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

import httpx
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.tauth import auth_headers

ERROR_WEIBO_SUB_MISSING = "weibo_sub_missing"
ERROR_WEIBO_RESOLVER_NOT_CONFIGURED = "weibo_uid_resolver_not_configured"
ERROR_WEIBO_UID_RESOLVE_FAILED = "weibo_uid_resolve_failed"
ERROR_WEIBO_UID_CHANGED = "weibo_uid_changed"
WEIBO_BINDING_PREFERENCE_KEY = "weibo_binding"
# Weibo video UID for TAuth requests.
WEIBO_VIDEO_UID = 5186027114
WEIBO_SUB_UID_RESOLVE_URL = "http://i.multimedia.api.weibo.com/snap_admin/auth.json"
WEIBO_SUB_UID_RESOLVE_TIMEOUT_SECONDS = 5.0


class WeiboBindingError(Exception):
    """Domain error raised by the Weibo binding flow."""

    def __init__(self, error_code: str, message: str):
        super().__init__(message)
        self.error_code = error_code
        self.message = message


@dataclass(frozen=True)
class WeiboAccountProfile:
    """Weibo account profile resolved from a SUB cookie."""

    uid: str
    screen_name: str | None
    avatar_url: str | None


@dataclass(frozen=True)
class WeiboBindingStatus:
    """Current Weibo binding state for a Wegent user."""

    bound: bool
    weibo_uid: str | None
    weibo_screen_name: str | None
    weibo_avatar_url: str | None
    weibo_bound_at: datetime | None


class WeiboAccountResolver(Protocol):
    """Resolver contract for converting a SUB cookie into a Weibo account profile."""

    async def resolve_account(self, sub_cookie: str) -> WeiboAccountProfile:
        """Resolve the Weibo account profile from a SUB cookie."""


class HttpWeiboAccountResolver:
    """HTTP resolver for the internal SUB-to-Weibo-account service."""

    async def resolve_account(self, sub_cookie: str) -> WeiboAccountProfile:
        """Call the configured internal endpoint and return a normalized profile."""
        endpoint = WEIBO_SUB_UID_RESOLVE_URL.strip()
        if not endpoint:
            raise WeiboBindingError(
                ERROR_WEIBO_RESOLVER_NOT_CONFIGURED,
                "Weibo UID resolver is not configured",
            )

        try:
            async with httpx.AsyncClient(
                timeout=WEIBO_SUB_UID_RESOLVE_TIMEOUT_SECONDS
            ) as client:
                response = await client.post(
                    endpoint,
                    headers=auth_headers(
                        WEIBO_VIDEO_UID,
                        {"Cookie": _build_sub_cookie_header(sub_cookie)},
                    ),
                )
                response.raise_for_status()
                data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise WeiboBindingError(
                ERROR_WEIBO_UID_RESOLVE_FAILED,
                "Failed to resolve Weibo UID from SUB cookie",
            ) from exc

        profile_payload = _extract_profile_payload(data)
        uid = _extract_uid(profile_payload)
        if uid is None:
            raise WeiboBindingError(
                ERROR_WEIBO_UID_RESOLVE_FAILED,
                "Weibo UID resolver response does not contain a valid uid",
            )
        return WeiboAccountProfile(
            uid=uid,
            screen_name=_extract_string(profile_payload, ["screen_name"]),
            avatar_url=_extract_string(
                profile_payload,
                ["avatar_large", "profile_image_url"],
            ),
        )


def _build_sub_cookie_header(sub_cookie: str) -> str:
    """Build the Cookie header expected by the internal Weibo account endpoint."""
    return f"SUB={sub_cookie}"


def _extract_profile_payload(data: Any) -> dict[str, Any]:
    """Extract the profile payload from the resolver response."""
    if not isinstance(data, dict):
        return {}

    user = data.get("user")
    if isinstance(user, dict):
        return user

    return {}


def _extract_uid(data: Any) -> str | None:
    """Extract a numeric UID from the resolver user payload."""
    if not isinstance(data, dict):
        return None

    candidate = data.get("id")
    if candidate is None:
        return None
    uid = str(candidate).strip()
    if uid.isdigit():
        return uid
    return None


def _extract_string(data: Any, keys: list[str]) -> str | None:
    """Extract a non-empty string from resolver response data."""
    if not isinstance(data, dict):
        return None

    for key in keys:
        value = data.get(key)
        if value is None:
            continue
        normalized = str(value).strip()
        if normalized:
            return normalized
    return None


class WeiboAccountBindingService:
    """Bind and unbind Wegent users to Weibo UIDs."""

    def __init__(self, resolver: WeiboAccountResolver | None = None):
        self._resolver = resolver or HttpWeiboAccountResolver()

    async def preview_current_weibo_account(
        self,
        *,
        sub_cookie: str | None,
    ) -> WeiboAccountProfile:
        """Resolve the Weibo account profile from the current browser SUB cookie."""
        if not sub_cookie:
            raise WeiboBindingError(
                ERROR_WEIBO_SUB_MISSING,
                "Weibo SUB cookie is missing",
            )
        return await self._resolver.resolve_account(sub_cookie)

    async def bind_current_user(
        self,
        db: Session,
        *,
        user: User,
        sub_cookie: str | None,
        expected_uid: str,
    ) -> WeiboBindingStatus:
        """Resolve SUB and bind the resulting Weibo UID to the current user."""
        normalized_expected_uid = str(expected_uid or "").strip()
        if not normalized_expected_uid:
            raise WeiboBindingError(
                ERROR_WEIBO_UID_CHANGED,
                "Expected Weibo UID is required before binding",
            )

        profile = await self.preview_current_weibo_account(sub_cookie=sub_cookie)
        if profile.uid != normalized_expected_uid:
            raise WeiboBindingError(
                ERROR_WEIBO_UID_CHANGED,
                "The current Weibo account changed after preview",
            )

        preferences = _load_preferences(user.preferences)
        preferences[WEIBO_BINDING_PREFERENCE_KEY] = {
            "uid": profile.uid,
            "screen_name": profile.screen_name,
            "avatar_url": profile.avatar_url,
            "bound_at": datetime.now(timezone.utc).isoformat(),
        }
        user.preferences = json.dumps(preferences)
        db.add(user)
        db.commit()
        db.refresh(user)
        return self.get_status(user)

    def unbind_current_user(self, db: Session, *, user: User) -> WeiboBindingStatus:
        """Clear the Weibo UID binding for the current user."""
        preferences = _load_preferences(user.preferences)
        preferences.pop(WEIBO_BINDING_PREFERENCE_KEY, None)
        user.preferences = json.dumps(preferences)
        db.add(user)
        db.commit()
        db.refresh(user)
        return self.get_status(user)

    @staticmethod
    def get_status(user: User) -> WeiboBindingStatus:
        """Build a binding status response from a user ORM object."""
        binding = _load_preferences(user.preferences).get(WEIBO_BINDING_PREFERENCE_KEY)
        if not isinstance(binding, dict):
            return WeiboBindingStatus(
                bound=False,
                weibo_uid=None,
                weibo_screen_name=None,
                weibo_avatar_url=None,
                weibo_bound_at=None,
            )

        uid = str(binding.get("uid") or "").strip()
        bound_at = _parse_bound_at(binding.get("bound_at"))
        return WeiboBindingStatus(
            bound=bool(uid),
            weibo_uid=uid or None,
            weibo_screen_name=_normalize_optional_string(binding.get("screen_name")),
            weibo_avatar_url=_normalize_optional_string(binding.get("avatar_url")),
            weibo_bound_at=bound_at,
        )


def _load_preferences(raw_preferences: Any) -> dict[str, Any]:
    """Load user preferences into a mutable dict."""
    if isinstance(raw_preferences, dict):
        return dict(raw_preferences)
    if not raw_preferences:
        return {}
    try:
        parsed = json.loads(raw_preferences)
    except (TypeError, json.JSONDecodeError):
        return {}
    return dict(parsed) if isinstance(parsed, dict) else {}


def _parse_bound_at(value: Any) -> datetime | None:
    """Parse the stored binding timestamp."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _normalize_optional_string(value: Any) -> str | None:
    """Normalize optional profile strings stored in preferences."""
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


weibo_account_binding_service = WeiboAccountBindingService()
