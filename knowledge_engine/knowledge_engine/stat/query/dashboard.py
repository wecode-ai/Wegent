# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dashboard query methods (KbStatDashboardMixin), extracted from query.py (P2-5 split)."""

import logging

from sqlalchemy import text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter
from knowledge_engine.stat.query.metadata import (
    _collector_for_metric,
    _iso,
    _successful_run_condition,
)

logger = logging.getLogger(__name__)


class KbStatDashboardMixin:
    def fetch_dashboard(self, filter: MetricFilter) -> dict:
        """Fetch all dashboard data in one call.

        Daily rows are aggregated across completed runs — for each stat_date
        the latest completed run's data is used. This supports incremental
        collection where each run covers only 1 day.
        """
        session = self._get_session()
        try:
            latest = self._latest_run(
                session,
                collector_name=(
                    "kb_daily_stats" if filter.kb_ids else "period_and_daily"
                ),
                kb_ids=filter.kb_ids,
            )
            if not latest:
                return {
                    "report_period": {
                        "start": _iso(filter.effective_period_start),
                        "end": _iso(filter.period_end_date),
                        "days": filter.period_days,
                    },
                    "generated_at": None,
                    "global_totals": None,
                    "period_totals": None,
                    "daily_rows": [],
                }

            # When a specific run_id is requested, fall through to the
            # normal latest-run resolution. The dashboard intentionally
            # does not pin a single run_id (it aggregates across runs per
            # stat_date), so a stale _fetch_single_run_dashboard path was
            # removed — it referenced a method that no longer exists.

            # KB-scoped dashboard: aggregate from metric tables
            if filter.kb_ids:
                return self._fetch_kb_dashboard(session, latest["id"], filter)

            # Snapshot sections resolve their own successful collector runs.
            # A precise retry of period_and_daily must not make global totals
            # or storage disappear merely because the retry run did not
            # execute those collectors.
            global_run_id, _ = self._resolve_run(
                session, filter, metric_name="global_totals"
            )
            gt_row = (
                session.execute(
                    text(
                        "SELECT * FROM kb_stat_global_totals WHERE run_id = :run_id LIMIT 1"
                    ),
                    {"run_id": global_run_id},
                ).fetchone()
                if global_run_id is not None
                else None
            )

            global_totals = None
            if gt_row:
                storage_run_id, _ = self._resolve_run(
                    session, filter, metric_name="storage_usage"
                )
                try:
                    storage_row = (
                        session.execute(
                            text(
                                "SELECT COALESCE(SUM(total_file_size), 0) "
                                "AS total_storage "
                                "FROM kb_stat_storage_usage WHERE run_id = :run_id"
                            ),
                            {"run_id": storage_run_id},
                        ).fetchone()
                        if storage_run_id is not None
                        else None
                    )
                    total_storage = int(storage_row.total_storage) if storage_row else 0
                except (ProgrammingError, OperationalError):
                    total_storage = 0

                global_totals = {
                    "total_kb_count": gt_row.total_kb_count,
                    "total_doc_count": gt_row.total_doc_count,
                    "total_storage": total_storage,
                    "dingtalk_synced_user_count": gt_row.dingtalk_synced_user_count,
                    "dingtalk_kb_count": gt_row.dingtalk_kb_count,
                    "dingtalk_doc_count": gt_row.dingtalk_doc_count,
                }

            # Daily rows — latest run per stat_date across all completed runs
            daily_rows_raw = self._fetch_aggregated_daily_rows(session, filter)

            # Period totals — derived from aggregated daily data
            period_totals = None
            if daily_rows_raw:
                period_total_queries = sum(r.total_queries for r in daily_rows_raw)
                period_new_kb = sum(r.new_kb_count for r in daily_rows_raw)
                period_new_docs = sum(r.new_doc_count for r in daily_rows_raw)
                period_rag_queries = sum(r.rag_queries for r in daily_rows_raw)
                period_direct_inject = sum(r.direct_injection for r in daily_rows_raw)
                period_kb_head_queries = sum(r.kb_head_queries for r in daily_rows_raw)

                active_kb_count = max(
                    (r.active_kb_count for r in daily_rows_raw), default=0
                )
                total_kb = gt_row.total_kb_count if gt_row else 0
                active_kb_ratio = (
                    round(active_kb_count / total_kb * 100, 2) if total_kb > 0 else None
                )

                period_totals = {
                    "period_total_queries": period_total_queries,
                    "period_new_kb": period_new_kb,
                    "period_new_docs": period_new_docs,
                    "period_rag_queries": period_rag_queries,
                    "period_direct_inject": period_direct_inject,
                    "period_kb_head_queries": period_kb_head_queries,
                    "active_kb_ratio": active_kb_ratio,
                }

            daily_rows = [
                {
                    "stat_date": _iso(r.stat_date),
                    "total_queries": r.total_queries,
                    "rag_queries": r.rag_queries,
                    "direct_injection": r.direct_injection,
                    "kb_head_rag_queries": r.kb_head_rag_queries,
                    "kb_head_queries": r.kb_head_queries,
                    "active_kb_count": r.active_kb_count,
                    "active_user_count": r.active_user_count,
                    "new_kb_count": r.new_kb_count,
                    "new_doc_count": r.new_doc_count,
                    "dingtalk_active_user_count": r.dingtalk_active_user_count,
                }
                for r in daily_rows_raw
            ]

            # --- Platform-level aggregate views (v1.3 time-series plan) ---
            # 1. Health distribution per day (for stacked area chart).
            #    Aggregated from per-KB health_score by target_date, grouped
            #    into tiers. This counters the Simpson's paradox risk where
            #    a single weighted-mean line hides a deteriorating tail.
            platform_health_dist = self._fetch_platform_health_distribution(
                session, filter
            )

            # 2. Platform retrieval quality (weighted-mean zero-chunk rate).
            #    Computed as SUM(zero_chunk_events)/SUM(total_events) per
            #    day — a true event-weighted mean, not a mean-of-means.
            platform_retrieval_quality = self._fetch_platform_retrieval_quality(
                session, filter
            )

            # 3-4. Platform-weighted hit / adoption rates. Same event-weighted
            #      pattern as retrieval quality (SUM(numerator)/SUM(denominator)
            #      per day) so the KPI top bar shows true platform means, not
            #      mean-of-means.
            platform_hit_rate = self._fetch_platform_hit_rate(session, filter)
            platform_adoption_rate = self._fetch_platform_adoption_rate(session, filter)

            return {
                "report_period": {
                    "start": _iso(filter.effective_period_start),
                    "end": _iso(filter.period_end_date),
                    "days": filter.period_days,
                },
                "generated_at": (
                    _iso(latest["completed_at"]) if latest["completed_at"] else None
                ),
                "global_totals": global_totals,
                "period_totals": period_totals,
                "daily_rows": daily_rows,
                "platform_health_distribution": platform_health_dist,
                "platform_retrieval_quality": platform_retrieval_quality,
                "platform_hit_rate": platform_hit_rate,
                "platform_adoption_rate": platform_adoption_rate,
            }
        except (ProgrammingError, OperationalError) as e:
            logger.warning(
                "Dashboard query failed (table/column may not exist yet): %s", e
            )
            return {
                "report_period": {
                    "start": _iso(filter.effective_period_start),
                    "end": _iso(filter.period_end_date),
                    "days": filter.period_days,
                },
                "generated_at": None,
                "global_totals": None,
                "period_totals": None,
                "daily_rows": [],
            }
        finally:
            session.close()

    def _fetch_aggregated_daily_rows(
        self, session: Session, filter: MetricFilter
    ) -> list:
        """Return the latest successfully collected platform row per date."""
        return session.execute(
            text("""
                SELECT d.*
                FROM kb_stat_daily_dashboard d
                JOIN (
                    SELECT dd.stat_date, MAX(dd.run_id) AS max_run
                    FROM kb_stat_daily_dashboard dd
                    JOIN kb_stat_runs r ON r.id = dd.run_id
                    JOIN kb_stat_collector_runs c
                      ON c.run_id = r.id
                     AND c.collector_name = 'period_and_daily'
                     AND c.status = 'success'
                    WHERE r.status IN ('completed', 'partial')
                      AND r.kb_filter IS NULL
                      AND dd.stat_date >= :start_date
                      AND dd.stat_date <= :end_date
                    GROUP BY dd.stat_date
                ) latest
                  ON latest.stat_date = d.stat_date
                 AND latest.max_run = d.run_id
                ORDER BY d.stat_date
                """),
            {
                "start_date": filter.effective_period_start,
                "end_date": filter.period_end_date,
            },
        ).fetchall()

    def _fetch_kb_dashboard(
        self,
        session: Session,
        run_id: int,
        filter: MetricFilter,
    ) -> dict:
        """Build the KB overview from per-KB daily and storage snapshots."""
        kb_id = int(filter.kb_ids[0])
        daily_rows = session.execute(
            text("""
                SELECT d.*
                FROM kb_stat_kb_daily_stats d
                JOIN (
                    SELECT ds.stat_date, ds.kb_id, MAX(ds.run_id) AS max_run
                    FROM kb_stat_kb_daily_stats ds
                    JOIN kb_stat_runs r ON r.id = ds.run_id
                    JOIN kb_stat_collector_runs c
                      ON c.run_id = r.id
                     AND c.collector_name = 'kb_daily_stats'
                     AND c.status = 'success'
                    WHERE r.status IN ('completed', 'partial')
                      AND (r.kb_filter IS NULL
                           OR JSON_CONTAINS(r.kb_filter, JSON_ARRAY(:kb_id)))
                      AND ds.kb_id = :kb_id
                      AND ds.stat_date >= :start_date
                      AND ds.stat_date <= :end_date
                    GROUP BY ds.stat_date, ds.kb_id
                ) latest
                  ON latest.stat_date = d.stat_date
                 AND latest.kb_id = d.kb_id
                 AND latest.max_run = d.run_id
                ORDER BY d.stat_date
                """),
            {
                "kb_id": kb_id,
                "start_date": filter.effective_period_start,
                "end_date": filter.period_end_date,
            },
        ).fetchall()

        storage_run, _ = self._resolve_run(session, filter, metric_name="storage_usage")
        storage = None
        if storage_run is not None:
            storage = session.execute(
                text("""
                    SELECT doc_count, total_file_size
                    FROM kb_stat_storage_usage
                    WHERE run_id = :run_id AND kb_id = :kb_id
                    LIMIT 1
                    """),
                {"run_id": storage_run, "kb_id": kb_id},
            ).fetchone()

        rows = [
            {
                "stat_date": _iso(row.stat_date),
                "total_queries": int(row.total_queries or 0),
                "rag_queries": int(row.rag_queries or 0),
                "direct_injection": int(row.direct_injection or 0),
                "kb_head_rag_queries": 0,
                "kb_head_queries": int(row.head_queries or 0),
                "active_kb_count": 1 if int(row.total_queries or 0) > 0 else 0,
                "active_user_count": int(row.active_user_count or 0),
                "new_kb_count": 0,
                "new_doc_count": int(row.new_doc_count or 0),
                "dingtalk_active_user_count": 0,
            }
            for row in daily_rows
        ]
        # active_kb_ratio for a single-KB view: fraction of days in the
        # window that had at least one query. The old `100.0 if rows else 0.0`
        # was meaningless — it returned 100% whenever any day had data.
        active_days = sum(1 for row in rows if int(row["total_queries"] or 0) > 0)
        active_kb_ratio = round(active_days / len(rows) * 100, 2) if rows else 0.0
        period_totals = {
            "period_total_queries": sum(row["total_queries"] for row in rows),
            "period_new_kb": 0,
            "period_new_docs": sum(row["new_doc_count"] for row in rows),
            "period_rag_queries": sum(row["rag_queries"] for row in rows),
            "period_direct_inject": sum(row["direct_injection"] for row in rows),
            "period_kb_head_queries": sum(row["kb_head_queries"] for row in rows),
            "active_kb_ratio": active_kb_ratio,
        }
        latest = self._latest_run(
            session,
            collector_name="kb_daily_stats",
            kb_ids=filter.kb_ids,
        )
        return {
            "report_period": {
                "start": _iso(filter.effective_period_start),
                "end": _iso(filter.period_end_date),
                "days": filter.period_days,
            },
            "generated_at": (
                _iso(latest["completed_at"])
                if latest and latest["completed_at"]
                else None
            ),
            "global_totals": {
                "total_kb_count": 1,
                "total_doc_count": int(storage.doc_count or 0) if storage else 0,
                "total_storage": (int(storage.total_file_size or 0) if storage else 0),
                "dingtalk_synced_user_count": 0,
                "dingtalk_kb_count": 0,
                "dingtalk_doc_count": 0,
            },
            "period_totals": period_totals,
            "daily_rows": rows,
        }

    def _fetch_platform_health_distribution(
        self, session: Session, filter: MetricFilter
    ) -> list[dict]:
        """Per-day KB count by health-score tier.

        Powers the stacked-area chart on the admin dashboard. Grouping
        per-KB health scores into tiers (excellent/good/fair/poor/no-data)
        per day reveals distribution shifts that a single weighted mean
        would mask (Simpson's paradox defense, v1.3 §8.2).

        **Dedup**: the same (stat_date, kb_id) can appear in multiple
        runs (manual re-trigger, backfill). We pick only the latest run
        per (stat_date, kb_id) via an INNER JOIN on MAX(run_id), otherwise
        SUM double-counts KBs and the stacked area shows inflated totals.

        **stat_date vs target_date**: collectors write one row per
        ``stat_date`` (the event day) while ``target_date`` is fixed to
        the run's target day. Grouping by ``target_date`` collapses a
        30-day lookback into a single point; grouping by ``stat_date``
        yields the per-day series the stacked-area chart needs.
        """
        run_condition, params = _successful_run_condition(
            "kb_health_score",
            filter,
            run_column="h.run_id",
            param_prefix="health_run",
        )
        conditions = [run_condition]
        if filter.effective_period_start:
            conditions.append("h.stat_date >= :start_date")
            params["start_date"] = filter.effective_period_start
        if filter.period_end_date:
            conditions.append("h.stat_date <= :end_date")
            params["end_date"] = filter.period_end_date
        where = " AND ".join(conditions)
        try:
            rows = session.execute(
                text(f"""
                    SELECT
                        h.stat_date,
                        SUM(CASE WHEN h.health_score >= 85 THEN 1 ELSE 0 END)
                            AS excellent,
                        SUM(CASE WHEN h.health_score >= 70
                                 AND h.health_score < 85 THEN 1 ELSE 0 END)
                            AS good,
                        SUM(CASE WHEN h.health_score >= 50
                                 AND h.health_score < 70 THEN 1 ELSE 0 END)
                            AS fair,
                        SUM(CASE WHEN h.health_score < 50
                                 AND h.health_score IS NOT NULL THEN 1 ELSE 0 END)
                            AS poor,
                        SUM(CASE WHEN h.health_score IS NULL THEN 1 ELSE 0 END)
                            AS no_data
                    FROM kb_stat_kb_health_score h
                    INNER JOIN (
                        SELECT hs.stat_date, hs.kb_id, MAX(hs.run_id) AS max_run
                        FROM kb_stat_kb_health_score hs
                        JOIN kb_stat_runs sr ON sr.id = hs.run_id
                        JOIN kb_stat_collector_runs sc
                          ON sc.run_id = sr.id
                         AND sc.collector_name = 'kb_health_score'
                         AND sc.status = 'success'
                        WHERE sr.status IN ('completed', 'partial')
                          AND sr.kb_filter IS NULL
                        GROUP BY hs.stat_date, hs.kb_id
                    ) latest
                        ON h.stat_date = latest.stat_date
                        AND h.kb_id = latest.kb_id
                        AND h.run_id = latest.max_run
                    WHERE {where}
                    GROUP BY h.stat_date
                    ORDER BY h.stat_date
                    """),
                params,
            ).fetchall()
        except (ProgrammingError, OperationalError):
            logger.warning("Platform health distribution query failed")
            return []
        return [
            {
                "stat_date": _iso(r.stat_date),
                "excellent": int(r.excellent or 0),
                "good": int(r.good or 0),
                "fair": int(r.fair or 0),
                "poor": int(r.poor or 0),
                "no_data": int(r.no_data or 0),
            }
            for r in rows
        ]

    def _fetch_platform_retrieval_quality(
        self, session: Session, filter: MetricFilter
    ) -> list[dict]:
        """Daily event-weighted platform zero-chunk rate.

        Computed as SUM(zero_chunk_queries) / SUM(total_queries) per day
        across ALL KBs — a true weighted mean, not a mean-of-means (v1.3
        §9.2). This is the companion line to the stacked-area chart so
        the two views always appear together (Simpson's paradox defense).

        **Dedup**: same cross-run dedup as health distribution — pick
        the latest run_id per (stat_date, kb_id) before aggregating.

        **stat_date vs target_date**: see _fetch_platform_health_distribution.
        """
        run_condition, params = _successful_run_condition(
            "kb_zero_chunk_rate",
            filter,
            run_column="z.run_id",
            param_prefix="quality_run",
        )
        conditions = [run_condition]
        if filter.effective_period_start:
            conditions.append("z.stat_date >= :start_date")
            params["start_date"] = filter.effective_period_start
        if filter.period_end_date:
            conditions.append("z.stat_date <= :end_date")
            params["end_date"] = filter.period_end_date
        where = " AND ".join(conditions)
        try:
            rows = session.execute(
                text(f"""
                    SELECT
                        z.stat_date,
                        SUM(z.zero_chunk_queries) AS zero_events,
                        SUM(z.total_queries) AS total_events
                    FROM kb_stat_kb_zero_chunk_rate z
                    INNER JOIN (
                        SELECT zs.stat_date, zs.kb_id, MAX(zs.run_id) AS max_run
                        FROM kb_stat_kb_zero_chunk_rate zs
                        JOIN kb_stat_runs sr ON sr.id = zs.run_id
                        JOIN kb_stat_collector_runs sc
                          ON sc.run_id = sr.id
                         AND sc.collector_name = 'kb_zero_chunk_rate'
                         AND sc.status = 'success'
                        WHERE sr.status IN ('completed', 'partial')
                          AND sr.kb_filter IS NULL
                        GROUP BY zs.stat_date, zs.kb_id
                    ) latest
                        ON z.stat_date = latest.stat_date
                        AND z.kb_id = latest.kb_id
                        AND z.run_id = latest.max_run
                    WHERE {where}
                    GROUP BY z.stat_date
                    ORDER BY z.stat_date
                    """),
                params,
            ).fetchall()
        except (ProgrammingError, OperationalError):
            logger.warning("Platform retrieval quality query failed")
            return []
        return [
            {
                "stat_date": _iso(r.stat_date),
                # Event-weighted rate: avoids the mean-of-means trap by
                # aggregating raw event counts, not per-KB rates.
                "zero_chunk_rate": (
                    round(int(r.zero_events or 0) / int(r.total_events or 1) * 100, 2)
                    if r.total_events and int(r.total_events) > 0
                    else None
                ),
                "total_queries": int(r.total_events or 0),
            }
            for r in rows
        ]

    def _fetch_platform_rate(
        self,
        session: Session,
        filter: MetricFilter,
        table: str,
        numerator_col: str,
    ) -> list[dict]:
        """Daily event-weighted platform rate (shared implementation).

        ``SUM(numerator_col) / SUM(total_queries)`` per day across all KBs,
        with the same latest-run-per-(stat_date, kb_id) dedup as
        ``_fetch_platform_retrieval_quality``. Used for hit / adoption rates
        so the admin KPI top bar shows true weighted means.

        **stat_date vs target_date**: see _fetch_platform_health_distribution.
        """
        metric_name_by_table = {
            "kb_stat_kb_retrieval_hit_rate": "kb_retrieval_hit_rate",
            "kb_stat_answer_adoption_rate": "answer_adoption_rate",
        }
        metric_name = metric_name_by_table[table]
        run_condition, params = _successful_run_condition(
            metric_name,
            filter,
            run_column="t.run_id",
            param_prefix=f"{metric_name}_run",
        )
        params["rate_collector"] = _collector_for_metric(metric_name)
        conditions = [run_condition]
        if filter.effective_period_start:
            conditions.append("t.stat_date >= :start_date")
            params["start_date"] = filter.effective_period_start
        if filter.period_end_date:
            conditions.append("t.stat_date <= :end_date")
            params["end_date"] = filter.period_end_date
        where = " AND ".join(conditions)
        try:
            rows = session.execute(
                text(f"""
                    SELECT
                        t.stat_date,
                        SUM(t.{numerator_col}) AS num_events,
                        SUM(t.total_queries) AS total_events
                    FROM {table} t
                    INNER JOIN (
                        SELECT rs.stat_date, rs.kb_id, MAX(rs.run_id) AS max_run
                        FROM {table} rs
                        JOIN kb_stat_runs sr ON sr.id = rs.run_id
                        JOIN kb_stat_collector_runs sc
                          ON sc.run_id = sr.id
                         AND sc.collector_name = :rate_collector
                         AND sc.status = 'success'
                        WHERE sr.status IN ('completed', 'partial')
                          AND sr.kb_filter IS NULL
                        GROUP BY rs.stat_date, rs.kb_id
                    ) latest
                        ON t.stat_date = latest.stat_date
                        AND t.kb_id = latest.kb_id
                        AND t.run_id = latest.max_run
                    WHERE {where}
                    GROUP BY t.stat_date
                    ORDER BY t.stat_date
                    """),
                params,
            ).fetchall()
        except (ProgrammingError, OperationalError):
            logger.warning("Platform rate query failed for %s", table)
            return []
        return [
            {
                "stat_date": _iso(r.stat_date),
                "rate": (
                    round(int(r.num_events or 0) / int(r.total_events or 1) * 100, 2)
                    if r.total_events and int(r.total_events) > 0
                    else None
                ),
                "total_queries": int(r.total_events or 0),
            }
            for r in rows
        ]

    def _fetch_platform_hit_rate(
        self, session: Session, filter: MetricFilter
    ) -> list[dict]:
        """Daily event-weighted platform retrieval hit rate."""
        return self._fetch_platform_rate(
            session, filter, "kb_stat_kb_retrieval_hit_rate", "hit_queries"
        )

    def _fetch_platform_adoption_rate(
        self, session: Session, filter: MetricFilter
    ) -> list[dict]:
        """Daily event-weighted platform answer adoption rate."""
        return self._fetch_platform_rate(
            session, filter, "kb_stat_answer_adoption_rate", "adopted_queries"
        )
