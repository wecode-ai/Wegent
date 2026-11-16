# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Local index strategy validation independent of storage SDKs."""

from typing import Any


def validate_index_strategy(strategy: dict[str, Any]) -> None:
    """Apply the same naming rules before an empty or nonempty listing."""
    mode = strategy.get("mode", "per_dataset")
    if mode == "fixed":
        if not strategy.get("fixedName"):
            raise ValueError("fixedName is required for 'fixed' index strategy mode")
        return
    if mode not in {"rolling", "per_dataset", "per_user"}:
        raise ValueError(f"Unknown index strategy mode: {mode}")
    if not strategy.get("prefix", "wegent"):
        raise ValueError(f"prefix cannot be empty for '{mode}' index strategy mode")
    if mode == "rolling":
        step = strategy.get("rollingStep", 10)
        if not isinstance(step, int) or step <= 0:
            raise ValueError(f"rollingStep must be a positive integer, got: {step}")
