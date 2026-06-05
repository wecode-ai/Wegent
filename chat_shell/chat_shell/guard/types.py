# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared types for chat_shell guard context governance.

This module defines TruncationPolicy and the GuardSource Protocol that
downstream guard implementations (T2-T9) depend on. It is intentionally
a leaf module with no internal chat_shell imports.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable

#: Default ratio applied to the normal limit when computing the emergency limit.
DEFAULT_EMERGENCY_RATIO = 0.3


@dataclass(frozen=True)
class TruncationPolicy:
    """Immutable policy describing what portion of a guard source to render.

    Attributes:
        kind: Unit of measurement — ``"bytes"`` or ``"tokens"``.
        limit: Maximum number of *kind* units to include.
    """

    kind: Literal["bytes", "tokens"]
    limit: int


@runtime_checkable
class GuardSource(Protocol):
    """Structural interface that every guard source adapter must satisfy.

    Adapters do **not** need to subclass this type; providing the three
    members below is sufficient for structural conformance (enforced at
    module load time via ``isinstance``).
    """

    name: str
    """Human-readable identifier for this guard source (e.g. ``"messages"``)."""

    def to_model_visible(self, raw: Any, policy: TruncationPolicy) -> str:
        """Render *raw* data into a model-visible string, respecting *policy*.

        Args:
            raw: The source-specific data to render.
            policy: The truncation policy to apply.

        Returns:
            A string suitable for inclusion in the model context window.
        """
        ...

    def emergency_policy(self, normal: TruncationPolicy) -> TruncationPolicy:
        """Return a reduced policy to use under emergency (memory-pressure) conditions.

        The default helper :func:`default_emergency_policy` provides a sensible
        implementation (30 % of *normal.limit*, floor 1). Adapters may override
        to implement source-specific shrinking.
        """
        ...


def default_emergency_policy(normal: TruncationPolicy) -> TruncationPolicy:
    """Return an emergency policy at 30 % of *normal.limit*, never below 1.

    >>> p = TruncationPolicy(kind="tokens", limit=100)
    >>> default_emergency_policy(p)
    TruncationPolicy(kind='tokens', limit=30)

    >>> default_emergency_policy(TruncationPolicy(kind="bytes", limit=2))
    TruncationPolicy(kind='bytes', limit=1)
    """
    return TruncationPolicy(
        kind=normal.kind,
        limit=max(1, int(normal.limit * DEFAULT_EMERGENCY_RATIO)),
    )
