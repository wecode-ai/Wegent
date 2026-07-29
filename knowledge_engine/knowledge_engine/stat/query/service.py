# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""KbStatQueryService (core metric + runs/health methods), extracted from query.py (P2-5 split)."""

import logging
import math
from dataclasses import asdict
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional, Sequence

from sqlalchemy import text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session, sessionmaker

from knowledge_engine.stat.filters import MetricFilter
from knowledge_engine.stat.metric_spec import _METRIC_SPECS
from knowledge_engine.stat.query.dashboard import KbStatDashboardMixin
from knowledge_engine.stat.query.metadata import (
    _collector_for_metric,
    _cross_run_latest_query,
    _iso,
    build_metric_list,
)
from knowledge_engine.stat.registry import all_collectors

logger = logging.getLogger(__name__)


class KbStatQueryService(KbStatDashboardMixin):
    """Generic read service for KB stat data."""

    def __init__(self, *, stat_session_factory: sessionmaker):
        self._stat_session_factory = stat_session_factory

    def _get_session(self) -> Session:
        return self._stat_session_factory()

    def _latest_run(
        self,
        session: Session,
        *,
        collector_name: Optional[str] = None,
        kb_ids: Optional[Sequence[int]] = None,
    ) -> Optional[dict]:
        """Return the latest successful run applicable to the requested scope."""
        conditions = ["r.status IN ('completed', 'partial')"]
        params: dict[str, Any] = {}
        join = ""
        if collector_name:
            join = (
                "JOIN kb_stat_collector_runs c ON c.run_id = r.id "
                "AND c.collector_name = :collector_name AND c.status = 'success' "
            )
            params["collector_name"] = collector_name
        if kb_ids:
            placeholders = []
            for index, kb_id in enumerate(kb_ids):
                key = f"scope_kb_{index}"
                placeholders.append(f":{key}")
                params[key] = kb_id
            requested_scope = ", ".join(placeholders)
            conditions.append(
                "(r.kb_filter IS NULL OR "
                f"JSON_CONTAINS(r.kb_filter, JSON_ARRAY({requested_scope})))"
            )
        else:
            # Platform-wide queries must never use a single-KB collection.
            conditions.append("r.kb_filter IS NULL")

        row = session.execute(
            text(
                "SELECT r.id, r.completed_at, r.status FROM kb_stat_runs r "
                f"{join}WHERE {' AND '.join(conditions)} "
                "ORDER BY r.id DESC LIMIT 1"
            ),
            params,
        ).fetchone()
        if not row:
            return None
        return {"id": row.id, "completed_at": row.completed_at, "status": row.status}

    def fetch_metric(self, name: str, filter: MetricFilter) -> dict:
        """Fetch a single metric by name with filter."""
        spec = _METRIC_SPECS.get(name)
        if spec is None:
            raise KeyError(f"unknown metric: {name}")

        session = self._get_session()
        try:
            run_id, run_completed_at = self._resolve_run(
                session, filter, metric_name=name
            )
            return self._fetch_one(
                session, name, spec, filter, run_id, run_completed_at
            )
        except (ProgrammingError, OperationalError) as e:
            logger.warning(
                "Stat table query failed (table/column may not exist yet): %s", e
            )
            return {
                "metric_name": name,
                "run_id": None,
                "run_completed_at": None,
                "schema": [asdict(c) for c in spec.schema],
                "rows": [],
            }
        finally:
            session.close()

    def fetch_metrics_batch(self, names: Sequence[str], filter: MetricFilter) -> dict:
        """Fetch multiple metrics in one session.

        Resolves the latest run once and reuses it for every metric, so a
        batch of N metrics costs one run-resolution + one session instead of
        N. Unknown metric names are returned as empty results rather than
        raising, so one bad name does not poison the whole batch.
        """
        results: dict[str, dict] = {}
        session = self._get_session()
        try:
            run_cache: dict[
                tuple[Optional[str], tuple[int, ...]],
                tuple[Optional[int], Optional[datetime]],
            ] = {}
            for name in names:
                spec = _METRIC_SPECS.get(name)
                if spec is None:
                    logger.warning("unknown metric in batch: %s", name)
                    results[name] = {
                        "metric_name": name,
                        "run_id": None,
                        "run_completed_at": None,
                        "schema": [],
                        "rows": [],
                    }
                    continue
                try:
                    cache_key = (
                        _collector_for_metric(name),
                        tuple(sorted(filter.kb_ids or [])),
                    )
                    if cache_key not in run_cache:
                        run_cache[cache_key] = self._resolve_run(
                            session, filter, metric_name=name
                        )
                    run_id, run_completed_at = run_cache[cache_key]
                    results[name] = self._fetch_one(
                        session, name, spec, filter, run_id, run_completed_at
                    )
                except (ProgrammingError, OperationalError) as e:
                    # Per-metric failure: log and emit an empty result so the
                    # rest of the batch still returns.
                    logger.warning("Stat table query failed for %s: %s", name, e)
                    results[name] = {
                        "metric_name": name,
                        "run_id": None,
                        "run_completed_at": None,
                        "schema": [asdict(c) for c in spec.schema],
                        "rows": [],
                    }
        finally:
            session.close()
        return {"results": results}

    def _resolve_run(
        self,
        session: Session,
        filter: MetricFilter,
        *,
        metric_name: Optional[str] = None,
    ) -> tuple[Optional[int], Optional[datetime]]:
        """Resolve a run that successfully produced the requested metric."""
        if filter.run_id is not None:
            collector_name = _collector_for_metric(metric_name)
            params: dict[str, Any] = {"id": filter.run_id}
            scope_condition = "r.kb_filter IS NULL"
            if filter.kb_ids:
                placeholders = []
                for index, kb_id in enumerate(filter.kb_ids):
                    key = f"explicit_kb_{index}"
                    placeholders.append(f":{key}")
                    params[key] = kb_id
                scope_condition = (
                    "(r.kb_filter IS NULL OR JSON_CONTAINS("
                    f"r.kb_filter, JSON_ARRAY({', '.join(placeholders)})))"
                )
            collector_join = ""
            if collector_name:
                collector_join = (
                    "JOIN kb_stat_collector_runs c ON c.run_id = r.id "
                    "AND c.collector_name = :collector_name "
                    "AND c.status = 'success' "
                )
                params["collector_name"] = collector_name
            run_row = session.execute(
                text(
                    "SELECT r.completed_at FROM kb_stat_runs r "
                    f"{collector_join}"
                    "WHERE r.id = :id "
                    "AND r.status IN ('completed', 'partial') "
                    f"AND {scope_condition}"
                ),
                params,
            ).fetchone()
            if run_row is None:
                return None, None
            return filter.run_id, run_row.completed_at
        latest = self._latest_run(
            session,
            collector_name=_collector_for_metric(metric_name) if metric_name else None,
            kb_ids=filter.kb_ids,
        )
        if latest:
            return latest["id"], latest["completed_at"]
        return None, None

    def _fetch_one(
        self,
        session: Session,
        name: str,
        spec,
        filter: MetricFilter,
        run_id: Optional[int],
        run_completed_at: Optional[datetime],
        *,
        ignore_limit: bool = False,
    ) -> dict:
        """Query one metric using an already-open session and resolved run.

        Two query paths depending on the metric's date_col semantics:

        - ``date_col`` is ``target_date`` or ``stat_date``: each run writes
          only the current day's row (the daily beat uses
          ``lookback_days=1``). To build a trend we must span ALL successful
          runs and pick the latest run per date (and per kb_id for per-KB
          tables) — see :func:`_cross_run_latest_query`.

        - ``date_col is None`` (snapshot metrics): no time axis, so the
          latest single run is sufficient.
        """
        table = spec.table
        schema = [asdict(c) for c in spec.schema]

        if run_id is None:
            return {
                "metric_name": name,
                "run_id": None,
                "run_completed_at": None,
                "schema": schema,
                "rows": [],
            }

        qopts = spec.query_options

        # --- Path A: target_date / stat_date metrics — cross-run aggregation ---
        if spec.date_col in ("target_date", "stat_date"):
            sql, params = _cross_run_latest_query(
                table=table,
                date_col=spec.date_col,
                spec=spec,
                filter=filter,
                metric_name=name,
                qopts=qopts,
                ignore_limit=ignore_limit,
            )
            rows = session.execute(text(sql), params).fetchall()
            return self._rows_to_metric_dict(
                rows, name, schema, run_id, run_completed_at
            )

        # --- Path B: snapshot metrics (date_col is None) — single latest run ---
        conditions = ["run_id = :run_id"]
        params = {"run_id": run_id}

        if spec.kb_col and filter.kb_ids:
            placeholders = ", ".join(f":kid_{i}" for i in range(len(filter.kb_ids)))
            conditions.append(f"{spec.kb_col} IN ({placeholders})")
            for i, kid in enumerate(filter.kb_ids):
                params[f"kid_{i}"] = kid

        where = " AND ".join(conditions)
        sql = f"SELECT * FROM {table} WHERE {where}"

        if qopts:
            if qopts.order_by:
                sql += f" ORDER BY {qopts.order_by}"
            if qopts.limit and not ignore_limit:
                sql += f" LIMIT {int(qopts.limit)}"

        rows = session.execute(text(sql), params).fetchall()
        return self._rows_to_metric_dict(rows, name, schema, run_id, run_completed_at)

    @staticmethod
    def _rows_to_metric_dict(
        rows: list,
        name: str,
        schema: list[dict],
        run_id: Optional[int],
        run_completed_at: Optional[datetime],
    ) -> dict:
        """Convert SQLAlchemy row proxies to a metric response dict."""
        result_rows = []
        for r in rows:
            row_dict = {}
            for col in r._fields:
                val = getattr(r, col)
                if isinstance(val, datetime):
                    val = _iso(val)
                elif isinstance(val, date):
                    val = _iso(val)
                elif isinstance(val, Decimal):
                    # MySQL ROUND()/AVG() may return Decimal, which is not
                    # JSON-serializable; coerce to float.
                    val = float(val)
                elif isinstance(val, float) and not math.isfinite(val):
                    # NaN / Infinity from a divide-by-zero in a SQL expression
                    # would produce invalid JSON; surface as null instead.
                    val = None
                row_dict[col] = val
            result_rows.append(row_dict)

        return {
            "metric_name": name,
            "run_id": run_id,
            "run_completed_at": _iso(run_completed_at),
            "schema": schema,
            "rows": result_rows,
        }

    def list_metrics(self, scope: str = "admin") -> list[dict]:
        """Return metric metadata based on queryable metric definitions."""
        return build_metric_list(scope=scope)

    def list_runs(
        self,
        limit: int = 20,
        offset: int = 0,
        status: Optional[str] = None,
        target_date_start: Optional[str] = None,
        target_date_end: Optional[str] = None,
    ) -> dict:
        session = self._get_session()
        try:
            conditions = []
            params: dict = {}

            if status:
                conditions.append("status = :status")
                params["status"] = status
            if target_date_start:
                conditions.append("target_date >= :date_start")
                params["date_start"] = target_date_start
            if target_date_end:
                conditions.append("target_date <= :date_end")
                params["date_end"] = target_date_end

            where = ""
            if conditions:
                where = "WHERE " + " AND ".join(conditions)

            total_row = session.execute(
                text(f"SELECT COUNT(*) FROM kb_stat_runs {where}"), params
            ).fetchone()
            total = total_row[0] if total_row else 0

            rows = session.execute(
                text(
                    f"SELECT id, started_at, completed_at, status, target_date, "
                    f"kb_filter, triggered_by, triggered_user_id, "
                    f"metrics_count, error_message, stat_start, stat_end "
                    f"FROM kb_stat_runs {where} "
                    f"ORDER BY id DESC LIMIT :limit OFFSET :offset"
                ),
                {**params, "limit": limit, "offset": offset},
            ).fetchall()

            return {
                "total": total,
                "runs": [
                    {
                        "id": r.id,
                        "started_at": (_iso(r.started_at)),
                        "completed_at": (_iso(r.completed_at)),
                        "status": r.status,
                        "target_date": (_iso(r.target_date)),
                        "kb_filter": r.kb_filter,
                        "triggered_by": r.triggered_by,
                        "triggered_user_id": r.triggered_user_id,
                        "metrics_count": r.metrics_count,
                        "error_message": r.error_message,
                        "stat_start": _iso(r.stat_start),
                        "stat_end": _iso(r.stat_end),
                    }
                    for r in rows
                ],
            }
        finally:
            session.close()

    def get_collector_runs(self, run_id: int) -> list[dict]:
        session = self._get_session()
        try:
            rows = session.execute(
                text(
                    "SELECT id, domain, collector_name, status, started_at, "
                    "completed_at, rows_written, duration_ms, error_message "
                    "FROM kb_stat_collector_runs WHERE run_id = :run_id "
                    "ORDER BY id"
                ),
                {"run_id": run_id},
            ).fetchall()
            return [
                {
                    "id": r.id,
                    "domain": r.domain,
                    "collector_name": r.collector_name,
                    "status": r.status,
                    "started_at": _iso(r.started_at),
                    "completed_at": (_iso(r.completed_at)),
                    "rows_written": r.rows_written,
                    "duration_ms": r.duration_ms,
                    "error_message": r.error_message,
                }
                for r in rows
            ]
        finally:
            session.close()

    def get_run(self, run_id: int) -> Optional[dict]:
        session = self._get_session()
        try:
            row = session.execute(
                text(
                    "SELECT id, started_at, completed_at, status, target_date, "
                    "kb_filter, triggered_by, triggered_user_id, metrics_count, "
                    "error_message, stat_start, stat_end "
                    "FROM kb_stat_runs WHERE id = :run_id"
                ),
                {"run_id": run_id},
            ).fetchone()
            if row is None:
                return None
            return {
                "id": row.id,
                "started_at": _iso(row.started_at),
                "completed_at": _iso(row.completed_at),
                "status": row.status,
                "target_date": _iso(row.target_date),
                "kb_filter": row.kb_filter,
                "triggered_by": row.triggered_by,
                "triggered_user_id": row.triggered_user_id,
                "metrics_count": row.metrics_count,
                "error_message": row.error_message,
                "stat_start": _iso(row.stat_start),
                "stat_end": _iso(row.stat_end),
            }
        finally:
            session.close()

    def health(self) -> dict:
        """Check stat DB connectivity and latest run status."""
        # The switches live on the runtime Settings (which is the layer
        # that owns deployment config). Lazy import keeps the engine
        # importable without the runtime installed (used by CLI scripts).
        try:
            from knowledge_runtime.config import get_settings

            runtime_settings = get_settings()
            enabled = runtime_settings.kb_stat_enabled
            prune_enabled = runtime_settings.kb_stat_prune_enabled
        except Exception:  # noqa: BLE001 - engine may run without runtime
            logger.debug("runtime settings unavailable; defaulting switches to True")
            enabled = True
            prune_enabled = True

        session = self._get_session()
        try:
            session.execute(text("SELECT 1"))
            latest = self._latest_run(session)
            return {
                "stat_db_ok": True,
                "worker_ok": latest is not None
                and latest["status"] in ("completed", "partial"),
                "enabled": enabled,
                "prune_enabled": prune_enabled,
                "latest_run_id": latest["id"] if latest else None,
                "latest_run_completed_at": (
                    _iso(latest["completed_at"])
                    if latest and latest["completed_at"]
                    else None
                ),
                "latest_run_status": latest["status"] if latest else None,
                "metrics_registered": len(all_collectors()),
            }
        except Exception:
            logger.exception("stat health check failed")
            return {
                "stat_db_ok": False,
                "worker_ok": False,
                "enabled": enabled,
                "prune_enabled": prune_enabled,
                "latest_run_id": None,
                "latest_run_completed_at": None,
                "latest_run_status": None,
                "metrics_registered": len(all_collectors()),
            }
        finally:
            session.close()
