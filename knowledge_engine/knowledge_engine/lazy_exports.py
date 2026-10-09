# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helper for re-exporting heavy submodules without importing them eagerly."""

from __future__ import annotations

from importlib import import_module
from typing import Any, Dict, List


def resolve_lazy_export(
    module_name: str,
    exports: Dict[str, str],
    name: str,
) -> Any:
    """Return one exported attribute, importing its module on first use."""
    target_module = exports.get(name)
    if target_module is None:
        raise AttributeError(f"module {module_name!r} has no attribute {name!r}")
    return getattr(import_module(target_module), name)


def lazy_export_names(exports: Dict[str, str]) -> List[str]:
    """Return the sorted names a lazy package re-exports."""
    return sorted(exports)
