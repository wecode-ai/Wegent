# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""KB stat query service package (split from the former query.py, P2-5).

Re-exports the public API so ``import knowledge_engine.stat.query`` continues
to expose ``KbStatQueryService``, ``build_metric_list`` and the ``_METRIC_*``
metadata dicts consumed by scripts/gen_metric_specs.py and verify_metric_specs.py.
"""

from knowledge_engine.stat.query.metadata import (
    _DOMAIN_LABELS,
    _METRIC_CHART_HINT,
    _METRIC_COLLECTOR_OVERRIDES,
    _METRIC_DATE_COL,
    _METRIC_DESCRIPTION,
    _METRIC_DOMAIN,
    _METRIC_KB_COL,
    _METRIC_LABELS,
    _METRIC_QUERY_OPTIONS,
    _METRIC_TABLES,
    build_metric_list,
)
from knowledge_engine.stat.query.schemas import _METRIC_SCHEMAS
from knowledge_engine.stat.query.service import KbStatQueryService

__all__ = [
    "KbStatQueryService",
    "build_metric_list",
    "_METRIC_SCHEMAS",
    "_METRIC_TABLES",
    "_METRIC_DATE_COL",
    "_METRIC_KB_COL",
    "_METRIC_QUERY_OPTIONS",
    "_METRIC_DOMAIN",
    "_METRIC_CHART_HINT",
    "_METRIC_DESCRIPTION",
    "_METRIC_LABELS",
    "_DOMAIN_LABELS",
    "_METRIC_COLLECTOR_OVERRIDES",
]
