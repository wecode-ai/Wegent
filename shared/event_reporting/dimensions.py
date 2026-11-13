# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Process-local telemetry dimensions from preloaded, non-blocking snapshots."""

import os
from collections.abc import Callable
from dataclasses import dataclass
from threading import Lock
from typing import Any, TypeVar


@dataclass(frozen=True)
class _OrganizationDimensions:
    org_id: str | None = None
    org_version: str | None = None


@dataclass(frozen=True)
class ActorDimensions(_OrganizationDimensions):
    """Organization of a user issuing a knowledge request."""


@dataclass(frozen=True)
class KnowledgeBaseDimensions(_OrganizationDimensions):
    """Organization owning a knowledge base."""


ActorProvider = Callable[[int], ActorDimensions | None]
KnowledgeBaseProvider = Callable[[int | str], KnowledgeBaseDimensions | None]
_actor_provider: ActorProvider | None = None
_knowledge_base_provider: KnowledgeBaseProvider | None = None
D = TypeVar("D", bound=_OrganizationDimensions)
_actor_owner: object | None = None
_knowledge_base_owner: object | None = None
_registration_lock = Lock()


def _reset_registration_lock() -> None:
    global _registration_lock, _actor_provider, _knowledge_base_provider
    global _actor_owner, _knowledge_base_owner
    _registration_lock = Lock()
    _actor_provider = _knowledge_base_provider = None
    _actor_owner = _knowledge_base_owner = None


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_registration_lock)


def _resolve(
    provider: Callable[[Any], D | None] | None, identifier: object, kind: type[D]
) -> D | None:
    if provider is None:
        return None
    try:
        value = provider(identifier)
        if not isinstance(value, kind):
            return None
        if not isinstance(value.org_id, str) or not 0 < len(value.org_id) <= 256:
            return None
        if value.org_version is not None and (
            not isinstance(value.org_version, str)
            or not 0 < len(value.org_version) <= 256
        ):
            return None
        return value
    except Exception:
        return None


def set_actor_provider(provider: ActorProvider | None) -> None:
    """Register an in-memory actor provider during process initialization."""
    global _actor_provider, _actor_owner
    with _registration_lock:
        _actor_provider = provider
        _actor_owner = None


def resolve_actor_dimensions(user_id: int | None) -> ActorDimensions | None:
    if type(user_id) is not int:
        return None
    return _resolve(_actor_provider, user_id, ActorDimensions)


def set_knowledge_base_provider(provider: KnowledgeBaseProvider | None) -> None:
    """Register an in-memory ownership provider in each reporting process."""
    global _knowledge_base_provider, _knowledge_base_owner
    with _registration_lock:
        _knowledge_base_provider = provider
        _knowledge_base_owner = None


def register_dimension_providers(
    actor: ActorProvider, knowledge_base: KnowledgeBaseProvider
) -> Callable[[], None]:
    """Install a process's providers and return an ownership-aware release."""
    global _actor_provider, _knowledge_base_provider
    global _actor_owner, _knowledge_base_owner
    owner = object()
    with _registration_lock:
        _actor_provider = actor
        _knowledge_base_provider = knowledge_base
        _actor_owner = _knowledge_base_owner = owner

    def release() -> None:
        global _actor_provider, _knowledge_base_provider
        global _actor_owner, _knowledge_base_owner
        with _registration_lock:
            if _actor_owner is owner:
                _actor_provider = None
                _actor_owner = None
            if _knowledge_base_owner is owner:
                _knowledge_base_provider = None
                _knowledge_base_owner = None

    return release


def knowledge_base_fields(kb_id: object) -> dict[str, str]:
    if not (
        type(kb_id) is int
        and kb_id.bit_length() <= 64
        or type(kb_id) is str
        and 0 < len(kb_id) <= 256
    ):
        return {}
    value = _resolve(_knowledge_base_provider, kb_id, KnowledgeBaseDimensions)
    if value is None or value.org_id is None:
        return {}
    result = {"asset_org_id": value.org_id}
    if value.org_version is not None:
        result["asset_org_version"] = value.org_version
    return result


def knowledge_base_ownerships(kb_ids: object) -> list[dict[str, object]] | None:
    """Return per-KB ownership without guessing unknown or duplicate IDs."""
    if _knowledge_base_provider is None or type(kb_ids) is not list:
        return None
    result: list[dict[str, object]] = []
    seen: set[tuple[type, object]] = set()
    for kb_id in kb_ids:
        if type(kb_id) not in (int, str):
            continue
        key = (type(kb_id), kb_id)
        if key not in seen:
            seen.add(key)
            result.append({"kb_id": kb_id, **knowledge_base_fields(kb_id)})
    return result or None
