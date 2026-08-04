# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Typed application handlers for the external Sites project API."""

from abc import ABC, abstractmethod
from typing import Any

from pydantic import ValidationError

from app.schemas.site import (
    ApplicationCapability,
    ApplicationTypeListResponse,
    ApplicationTypeResponse,
    MiniProgramResponse,
    SiteAppType,
    SiteListItem,
    SiteResponse,
)


class InvalidApplicationProjectError(ValueError):
    """Raised when an upstream project cannot be converted to an application."""


class ApplicationTypeHandler(ABC):
    """Convert and describe one supported Sites application type."""

    app_type: SiteAppType
    order: int
    capabilities: tuple[ApplicationCapability, ...]

    def matches(self, payload: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        return payload.get("app_type", "site") == self.app_type

    @abstractmethod
    def parse(self, payload: Any, *, username: str) -> SiteListItem:
        """Validate one upstream project and return its typed application."""

    def descriptor(self) -> ApplicationTypeResponse:
        return ApplicationTypeResponse(
            app_type=self.app_type,
            order=self.order,
            capabilities=list(self.capabilities),
        )


class SiteApplicationHandler(ApplicationTypeHandler):
    app_type: SiteAppType = "site"
    order: int = 10
    capabilities: tuple[ApplicationCapability, ...] = (
        "create",
        "publish",
        "delete",
    )

    def parse(self, payload: Any, *, username: str) -> SiteResponse:
        if not isinstance(payload, dict):
            raise InvalidApplicationProjectError("invalid site project")
        url = payload.get("url")
        if not isinstance(url, str) or not url:
            raise InvalidApplicationProjectError("site project does not have a URL")
        network = payload.get("network")
        project_id = payload.get("id")
        created_at = payload.get("created_at")
        snapshot = payload.get("snapshot")
        site = {
            "app_type": self.app_type,
            "siteid": project_id,
            "taskid": project_id,
            "username": username,
            "name": payload.get("title"),
            "slug": project_id,
            "internal_url": url,
            "external_url": url if network == "outer" else None,
            "publish_status": "published" if network == "outer" else "unpublished",
            "last_publish_error": None,
            "thumbnail_url": (
                snapshot if isinstance(snapshot, str) and snapshot else None
            ),
            "created_at": created_at,
            "updated_at": created_at,
            "published_at": None,
        }
        try:
            return SiteResponse.model_validate(site)
        except ValidationError as exc:
            raise InvalidApplicationProjectError("invalid site project") from exc


class MiniProgramApplicationHandler(ApplicationTypeHandler):
    app_type: SiteAppType = "mini_program"
    order: int = 20
    capabilities: tuple[ApplicationCapability, ...] = (
        "create",
        "open_experience",
    )

    def parse(self, payload: Any, *, username: str) -> MiniProgramResponse:
        if not isinstance(payload, dict):
            raise InvalidApplicationProjectError("invalid mini program project")
        project_id = payload.get("id")
        created_at = payload.get("created_at")
        snapshot = payload.get("snapshot")
        mini_program = {
            "app_type": self.app_type,
            "siteid": project_id,
            "taskid": project_id,
            "username": username,
            "name": payload.get("title"),
            "slug": project_id,
            "app_id": payload.get("app_id"),
            "status": payload.get("status"),
            "version": payload.get("version"),
            "experience_url": payload.get("experience_url"),
            "thumbnail_url": (
                snapshot if isinstance(snapshot, str) and snapshot else None
            ),
            "created_at": created_at,
            "updated_at": payload.get("updated_at", created_at),
        }
        try:
            return MiniProgramResponse.model_validate(mini_program)
        except ValidationError as exc:
            raise InvalidApplicationProjectError(
                "invalid mini program project"
            ) from exc


SITE_APPLICATION_HANDLER = SiteApplicationHandler()
APPLICATION_TYPE_HANDLERS: tuple[ApplicationTypeHandler, ...] = (
    SITE_APPLICATION_HANDLER,
    MiniProgramApplicationHandler(),
)
APPLICATION_TYPE_HANDLER_BY_NAME = {
    handler.app_type: handler for handler in APPLICATION_TYPE_HANDLERS
}


def get_application_type_handler(app_type: SiteAppType) -> ApplicationTypeHandler:
    """Return the registered handler for one validated application type."""
    return APPLICATION_TYPE_HANDLER_BY_NAME[app_type]


def list_application_types() -> ApplicationTypeListResponse:
    """Return enabled application types in their stable UI order."""
    return ApplicationTypeListResponse(
        items=[handler.descriptor() for handler in APPLICATION_TYPE_HANDLERS]
    )
