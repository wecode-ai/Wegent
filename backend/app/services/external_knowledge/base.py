# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared contracts for external knowledge providers."""

from dataclasses import dataclass
from typing import Any, Protocol

from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.kind import DefaultContextRef


@dataclass(frozen=True)
class ResolvedExternalKnowledge:
    """Resolved task context data for an external knowledge ref."""

    context_ref: dict[str, Any] | None = None
    warning: dict[str, Any] | None = None


class ExternalKnowledgeProvider(Protocol):
    """Provider contract for external knowledge default context refs."""

    provider: str

    def supports(self, ref: DefaultContextRef) -> bool:
        """Return whether this provider can resolve the ref."""
        ...

    def resolve(
        self,
        db: Session,
        user: User,
        ref: DefaultContextRef,
        bound_at: str,
    ) -> ResolvedExternalKnowledge:
        """Resolve a default ref into a task context ref or warning."""
        ...

    def context_item_to_default_ref(
        self, raw: dict[str, Any]
    ) -> DefaultContextRef | None:
        """Parse an explicit UI context item into a typed default ref."""
        ...

    def validate_ref(
        self,
        db: Session,
        user: User,
        ref: DefaultContextRef,
        namespace: str,
    ) -> None:
        """Validate whether a default ref can be saved."""
        ...

    def supports_task_context(self, context: dict[str, Any]) -> bool:
        """Return whether this provider can handle a task-level context."""
        ...

    def get_runtime_skill_names(self, context: dict[str, Any]) -> list[str]:
        """Return runtime skills needed by a task-level context."""
        ...

    def build_runtime_guidance(self, contexts: list[dict[str, Any]]) -> str | None:
        """Build provider-specific runtime guidance for task-level contexts."""
        ...
