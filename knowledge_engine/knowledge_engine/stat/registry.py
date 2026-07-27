# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Decorator-based collector registry.

Collectors are registered via @register_collector and discovered
at runtime by the runner.
"""

import logging
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol, Sequence

logger = logging.getLogger(__name__)


class CollectorFn(Protocol):
    def __call__(
        self,
        run_id: int,
        mfilter: "MetricFilter",  # noqa: F821
        *,
        source_session,
        stat_session,
    ) -> int: ...


@dataclass
class CollectorMeta:
    name: str
    domain: str
    fn: Callable
    description: str = ""
    chart_hint: str = "table"  # line / bar / pie / cards / table
    enabled: bool = True


_REGISTRY: list[CollectorMeta] = []
_IMPORTS_DONE = False


def _ensure_imports() -> None:
    """Lazily import collector modules to trigger @register_collector decorators."""
    global _IMPORTS_DONE
    if _IMPORTS_DONE:
        return
    # Collector registration is part of service startup correctness.  Never
    # swallow an import failure: a partially populated registry makes runs look
    # successful while silently omitting metrics.
    import knowledge_engine.stat.collectors  # noqa: F401

    _IMPORTS_DONE = True


def register_collector(
    *,
    domain: str,
    name: Optional[str] = None,
    description: str = "",
    chart_hint: str = "table",
    enabled: bool = True,
):
    """Decorator to register a collector function."""

    def deco(fn: Callable) -> Callable:
        _REGISTRY.append(
            CollectorMeta(
                name=name or fn.__name__,
                domain=domain,
                fn=fn,
                description=description,
                chart_hint=chart_hint,
                enabled=enabled,
            )
        )
        return fn

    return deco


def all_collectors() -> list[CollectorMeta]:
    _ensure_imports()
    return [c for c in _REGISTRY if c.enabled]


def collectors_by_domain(domain: str) -> list[CollectorMeta]:
    _ensure_imports()
    return [c for c in _REGISTRY if c.domain == domain and c.enabled]


def collectors_by_domains(domains: Sequence[str]) -> list[CollectorMeta]:
    _ensure_imports()
    domain_set = set(domains)
    return [c for c in _REGISTRY if c.domain in domain_set and c.enabled]


def collectors_by_names(names: Sequence[str]) -> list[CollectorMeta]:
    _ensure_imports()
    name_set = set(names)
    collectors = [c for c in _REGISTRY if c.name in name_set and c.enabled]
    missing = name_set - {c.name for c in collectors}
    if missing:
        raise ValueError(f"Unknown or disabled collectors: {sorted(missing)}")
    return collectors


def metric_list(scope: str = "admin") -> list[dict]:
    """Return metric metadata grouped by domain (deprecated thin wrapper).

    Prefer knowledge_engine.stat.query.build_metric_list. Kept only as a
    backward-compatible shim; the canonical implementation lives in query.py
    (not metric_spec.py, which is a codegen artifact).
    """
    from knowledge_engine.stat.query import build_metric_list

    return build_metric_list(scope=scope)
