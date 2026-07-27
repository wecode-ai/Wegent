#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify metric_spec._METRIC_SPECS is equivalent to query.py's 9 legacy dicts.

Regression gate for the A1 refactor. Run before deleting the legacy dicts
(Phase 1B) and after any future collector/metadata change:

    cd knowledge_engine && .venv/bin/python ../scripts/verify_metric_specs.py

Three assertion layers:
  A. Key-set equivalence (_METRIC_SPECS keys == SCHEMAS keys).
  B. Per-metric, per-field byte equivalence (with .get fallbacks matching
     list_metrics/fetch_metrics behavior, tolerating the known drift where
     DESCRIPTION omits 2 metrics and QUERY_OPTIONS omits 3).
  C. ColumnSpec contract: each column dict has exactly {key, type, label},
     matching shared/models/kb_stat.py FieldSchema.
"""

from dataclasses import asdict

import knowledge_engine.stat.query as q
from knowledge_engine.stat.metric_spec import _METRIC_SPECS


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# --- A. Key-set equivalence ---
schema_keys = set(q._METRIC_SCHEMAS.keys())
check(
    set(_METRIC_SPECS.keys()) == schema_keys,
    f"key-set mismatch: only-in-specs={set(_METRIC_SPECS) - schema_keys}, "
    f"missing-from-specs={schema_keys - set(_METRIC_SPECS)}",
)
# Dicts that must be fully aligned with SCHEMAS.
for dname in ("TABLES", "DATE_COL", "KB_COL", "DOMAIN", "CHART_HINT"):
    check(
        set(getattr(q, f"_METRIC_{dname}").keys()) == schema_keys,
        f"{dname} key-set drifts from SCHEMAS",
    )

# --- B. Per-metric field equivalence ---
for name, spec in _METRIC_SPECS.items():
    check(spec.name == name, f"{name}.name")
    check(spec.table == q._METRIC_TABLES[name], f"{name}.table")
    check(spec.domain == q._METRIC_DOMAIN[name], f"{name}.domain")
    # label/description use .get fallbacks (DESCRIPTION omits daily_dashboard
    # and period_totals; that drift is preserved, not "fixed", in this refactor)
    check(spec.label == q._METRIC_LABELS.get(name, name), f"{name}.label")
    check(
        spec.description == q._METRIC_DESCRIPTION.get(name, ""), f"{name}.description"
    )
    check(
        spec.chart_hint == q._METRIC_CHART_HINT.get(name, "table"), f"{name}.chart_hint"
    )
    check(spec.date_col == q._METRIC_DATE_COL.get(name), f"{name}.date_col")
    check(spec.kb_col == q._METRIC_KB_COL.get(name), f"{name}.kb_col")

    # schema: tuple[ColumnSpec] -> list[dict] must equal the legacy list[dict]
    new_schema = [asdict(c) for c in spec.schema]
    check(new_schema == q._METRIC_SCHEMAS[name], f"{name}.schema differs")

    # query_options is sparse (63/66); None must round-trip as None
    old_qo = q._METRIC_QUERY_OPTIONS.get(name)
    if old_qo is None:
        check(spec.query_options is None, f"{name} query_options should be None")
    else:
        check(spec.query_options is not None, f"{name} query_options missing")
        check(
            spec.query_options.order_by == old_qo.get("order_by"),
            f"{name}.query_options.order_by",
        )
        check(
            spec.query_options.limit == old_qo.get("limit"),
            f"{name}.query_options.limit",
        )

# --- C. ColumnSpec contract: exactly {key, type, label} (Pydantic FieldSchema) ---
for name, spec in _METRIC_SPECS.items():
    for col in spec.schema:
        d = asdict(col)
        check(
            set(d.keys()) == {"key", "type", "label"},
            f"{name} column {col.key!r} has extra keys: {set(d.keys())}",
        )

print(f"OK: {len(_METRIC_SPECS)} metric specs verified identical to legacy dicts")
