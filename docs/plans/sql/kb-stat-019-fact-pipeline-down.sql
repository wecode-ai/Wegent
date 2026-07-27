-- KB-stat 019 rollback. Apply only to the statistics database.

DROP TABLE kb_stat_metric_watermarks;
DROP TABLE kb_stat_source_watermarks;
DROP TABLE kb_stat_stage_query_event;
DROP TABLE kb_stat_extractor_runs;
ALTER TABLE kb_stat_kb_daily_stats DROP COLUMN total_queries;
ALTER TABLE kb_stat_collector_runs DROP COLUMN duration_ms;
