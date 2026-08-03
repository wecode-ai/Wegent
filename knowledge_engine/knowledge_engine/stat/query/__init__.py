# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""KB stat query service package.

Re-exports the public API: ``KbStatQueryService`` and ``build_metric_list``.
Metric metadata is the single source of truth in ``metric_spec.py``
(``_METRIC_SPECS``); there are no parallel legacy dicts.
"""

from knowledge_engine.stat.query.metadata import build_metric_list
from knowledge_engine.stat.query.service import KbStatQueryService

__all__ = [
    "KbStatQueryService",
    "build_metric_list",
]
