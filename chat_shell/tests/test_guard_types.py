# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for chat_shell.guard.types — TruncationPolicy + GuardSource Protocol (T1)."""

from __future__ import annotations

from typing import Any, runtime_checkable

import pytest

from chat_shell.guard import (
    DEFAULT_EMERGENCY_RATIO,
    GuardSource,
    TruncationPolicy,
    default_emergency_policy,
)

# ---------------------------------------------------------------------------
# Dummy adapter for structural conformance checks
# ---------------------------------------------------------------------------


class _DummyGuardSource:
    """Minimal adapter that satisfies the GuardSource Protocol structurally."""

    name = "dummy"

    def to_model_visible(self, raw: Any, policy: TruncationPolicy) -> str:
        return str(raw)[: policy.limit]

    def emergency_policy(self, normal: TruncationPolicy) -> TruncationPolicy:
        return default_emergency_policy(normal)


# =============================================================================
# TruncationPolicy
# =============================================================================


class TestTruncationPolicy:
    def test_is_frozen(self):
        """Mutation must raise an exception."""
        policy = TruncationPolicy(kind="tokens", limit=100)

        with pytest.raises(Exception):
            policy.limit = 200  # type: ignore[misc]

    def test_is_hashable(self):
        """Identical policies must have the same hash."""
        p1 = TruncationPolicy(kind="bytes", limit=500)
        p2 = TruncationPolicy(kind="bytes", limit=500)

        assert hash(p1) == hash(p2)
        assert p1 == p2

        # Use as dict key to confirm hashability at runtime.
        d = {p1: "value"}
        assert d[p2] == "value"

    def test_equality_and_repr(self):
        """Different limits or kinds must compare unequal."""
        a = TruncationPolicy(kind="tokens", limit=100)
        b = TruncationPolicy(kind="tokens", limit=200)
        c = TruncationPolicy(kind="bytes", limit=100)

        assert a != b
        assert a != c
        assert repr(a) == "TruncationPolicy(kind='tokens', limit=100)"


# =============================================================================
# GuardSource Protocol
# =============================================================================


class TestGuardSourceProtocol:
    def test_is_runtime_checkable(self):
        """GuardSource must be decorated with @runtime_checkable."""
        assert hasattr(GuardSource, "_is_runtime_protocol")
        assert GuardSource._is_runtime_protocol is True

    def test_dummy_adapter_satisfies_protocol(self):
        """A structurally-conforming adapter passes isinstance check."""
        adapter = _DummyGuardSource()
        assert isinstance(adapter, GuardSource)

    def test_incomplete_adapter_fails_protocol(self):
        """An object missing a member must not satisfy the protocol."""

        class Incomplete:
            name = "incomplete"

        assert not isinstance(Incomplete(), GuardSource)


# =============================================================================
# default_emergency_policy
# =============================================================================


class TestDefaultEmergencyPolicy:
    def test_returns_reduced_policy_same_kind(self):
        """Emergency policy keeps the same kind with 30 % of the normal limit."""
        normal = TruncationPolicy(kind="tokens", limit=100)
        emergency = default_emergency_policy(normal)

        assert emergency.kind == "tokens"
        assert emergency.limit == int(100 * DEFAULT_EMERGENCY_RATIO)

    def test_floor_never_below_one(self):
        """When 30 % of normal.limit rounds to 0, the floor must be 1."""
        # limit=2 → 2 * 0.3 = 0.6 → int(0.6) = 0, floor → 1
        emergency = default_emergency_policy(TruncationPolicy(kind="bytes", limit=2))
        assert emergency.limit == 1

        # limit=1 → 1 * 0.3 = 0.3 → int(0.3) = 0, floor → 1
        emergency = default_emergency_policy(TruncationPolicy(kind="bytes", limit=1))
        assert emergency.limit == 1

        # limit=0 → 0 * 0.3 = 0, floor → 1
        emergency = default_emergency_policy(TruncationPolicy(kind="tokens", limit=0))
        assert emergency.limit == 1

    def test_returns_new_instance(self):
        """The emergency policy must be a new object, not a mutation."""
        normal = TruncationPolicy(kind="tokens", limit=50)
        emergency = default_emergency_policy(normal)

        assert emergency is not normal
        assert normal.limit == 50  # Original unchanged
