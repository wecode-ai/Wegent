# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Typed application handlers for the external Sites project API."""

from abc import ABC, abstractmethod
from typing import Any, cast

from pydantic import ValidationError

from app.schemas.site import (
    ApplicationCapability,
    ApplicationCreatePluginResponse,
    ApplicationTypeListResponse,
    ApplicationTypeResponse,
    MiniProgramResponse,
    SiteAppType,
    SiteListItem,
    SiteNetwork,
    SiteResponse,
)
from app.services.builtin_plugin_registry import (
    BUILTIN_MINI_PROGRAM_PLUGIN_NAME,
    BUILTIN_PLUGINS_BY_NAME,
    BUILTIN_SITES_PLUGIN_NAME,
)
from app.services.plugin_marketplace_identity import marketplace_name_for_visibility

APPLICATION_PLUGIN_MARKETPLACE = marketplace_name_for_visibility("workspace")


class InvalidApplicationProjectError(ValueError):
    """Raised when an upstream project cannot be converted to an application."""


APPLICATION_TYPE_ALIASES: dict[str, SiteAppType] = {
    "site": "web",
    "mini_program": "miniapp",
}


def normalize_application_type(app_type: Any) -> str:
    """Normalize historical Sites app type names to the current contract."""

    value = app_type.strip() if isinstance(app_type, str) else ""
    return APPLICATION_TYPE_ALIASES.get(value or "web", value or "web")


def normalize_site_network(network: Any) -> SiteNetwork:
    return (
        cast(SiteNetwork, network)
        if isinstance(network, str) and network in {"inner", "outer"}
        else "inner"
    )


class ApplicationTypeHandler(ABC):
    """Convert and describe one supported Sites application type."""

    app_type: SiteAppType
    order: int
    capabilities: tuple[ApplicationCapability, ...]
    create_plugin_name: str | None = None
    create_marketplace_name: str = APPLICATION_PLUGIN_MARKETPLACE

    def matches(self, payload: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        return (
            normalize_application_type(
                payload.get("app_type") or payload.get("project_type")
            )
            == self.app_type
        )

    @abstractmethod
    def parse(self, payload: Any, *, username: str) -> SiteListItem:
        """Validate one upstream project and return its typed application."""

    def descriptor(self) -> ApplicationTypeResponse:
        builtin_plugin = (
            BUILTIN_PLUGINS_BY_NAME.get(self.create_plugin_name)
            if self.create_plugin_name
            else None
        )
        create_marketplace_name = (
            marketplace_name_for_visibility(builtin_plugin.visibility)
            if builtin_plugin
            else self.create_marketplace_name
        )
        return ApplicationTypeResponse(
            app_type=self.app_type,
            order=self.order,
            capabilities=list(self.capabilities),
            create=(
                ApplicationCreatePluginResponse(
                    plugin_name=self.create_plugin_name,
                    marketplace_name=create_marketplace_name,
                )
                if self.create_plugin_name
                else None
            ),
        )


class SiteApplicationHandler(ApplicationTypeHandler):
    app_type: SiteAppType = "web"
    order: int = 10
    capabilities: tuple[ApplicationCapability, ...] = (
        "create",
        "publish",
        "edit",
        "delete",
        "configure_environment",
        "manage_access",
    )
    create_plugin_name = BUILTIN_SITES_PLUGIN_NAME

    def parse(self, payload: Any, *, username: str) -> SiteResponse:
        if not isinstance(payload, dict):
            raise InvalidApplicationProjectError("invalid site project")
        url = payload.get("url")
        if not isinstance(url, str) or not url:
            raise InvalidApplicationProjectError("site project does not have a URL")
        network = normalize_site_network(payload.get("network"))
        version_status = payload.get("version_status")
        project_id = payload.get("id")
        owner_username = payload.get("owner_username")
        access_role = payload.get("access_role")
        if not isinstance(owner_username, str) or access_role not in {
            "owner",
            "collaborator",
        }:
            raise InvalidApplicationProjectError("site project has invalid membership")
        created_at = payload.get("created_at")
        snapshot = payload.get("snapshot")
        site = {
            "app_type": self.app_type,
            "siteid": project_id,
            "project_id": project_id,
            "taskid": project_id,
            "username": owner_username,
            "owner_username": owner_username,
            "access_role": access_role,
            "name": payload.get("title"),
            "slug": payload.get("slug") or project_id,
            "custom_domain_prefix": payload.get("custom_domain_prefix"),
            "network": network,
            "internal_url": url,
            "external_url": url if network == "outer" else None,
            "publish_status": (
                "scanning"
                if version_status == "scanning"
                else "published" if network == "outer" else "unpublished"
            ),
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
    app_type: SiteAppType = "miniapp"
    order: int = 20
    capabilities: tuple[ApplicationCapability, ...] = (
        "create",
        "open_experience",
    )
    create_plugin_name = BUILTIN_MINI_PROGRAM_PLUGIN_NAME

    def parse(self, payload: Any, *, username: str) -> MiniProgramResponse:
        if not isinstance(payload, dict):
            raise InvalidApplicationProjectError("invalid mini program project")
        project_id = payload.get("id")
        created_at = payload.get("created_at")
        snapshot = payload.get("snapshot")
        network = normalize_site_network(payload.get("network"))
        owner_username = payload.get("owner_username")
        access_role = payload.get("access_role")
        if not isinstance(owner_username, str) or access_role not in {
            "owner",
            "collaborator",
        }:
            raise InvalidApplicationProjectError("mini program has invalid membership")
        mini_program = {
            "app_type": self.app_type,
            "siteid": project_id,
            "project_id": project_id,
            "taskid": project_id,
            "username": owner_username,
            "owner_username": owner_username,
            "access_role": access_role,
            "name": payload.get("title"),
            "slug": project_id,
            "app_id": payload.get("app_id"),
            "status": payload.get("status")
            or ("published" if network == "outer" else "experience"),
            "version": payload.get("version"),
            "experience_url": payload.get("experience_url") or payload.get("url"),
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
    return APPLICATION_TYPE_HANDLER_BY_NAME[normalize_application_type(app_type)]


def list_application_types() -> ApplicationTypeListResponse:
    """Return enabled application types in their stable UI order."""
    return ApplicationTypeListResponse(
        items=[handler.descriptor() for handler in APPLICATION_TYPE_HANDLERS]
    )
