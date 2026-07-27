-- KB-stat 019: statistics-only fact pipeline.
-- Apply only to KNOWLEDGE_STAT_DATABASE_URL. Never apply to the business DB.

ALTER TABLE kb_stat_kb_daily_stats
    ADD COLUMN total_queries INTEGER NOT NULL DEFAULT 0 AFTER kb_id;
ALTER TABLE kb_stat_collector_runs
    ADD COLUMN duration_ms BIGINT NOT NULL DEFAULT 0 AFTER rows_written;

CREATE TABLE kb_stat_extractor_runs (
    id BIGINT NOT NULL AUTO_INCREMENT,
    run_id BIGINT NOT NULL,
    extractor_name VARCHAR(128) NOT NULL,
    status VARCHAR(20) NOT NULL,
    source_cutoff VARCHAR(255),
    started_at DATETIME NOT NULL,
    completed_at DATETIME,
    rows_read BIGINT NOT NULL DEFAULT 0,
    rows_written BIGINT NOT NULL DEFAULT 0,
    batches INTEGER NOT NULL DEFAULT 0,
    duration_ms BIGINT NOT NULL DEFAULT 0,
    error_message TEXT,
    PRIMARY KEY (id),
    CONSTRAINT uq_kb_stat_extractor_run UNIQUE (run_id, extractor_name),
    INDEX ix_kb_stat_extractor_status (status, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kb_stat_stage_query_event (
    run_id BIGINT NOT NULL,
    event_id BIGINT NOT NULL,
    event_time DATETIME NOT NULL,
    stat_date DATE NOT NULL,
    kb_id BIGINT,
    user_id BIGINT,
    injection_mode VARCHAR(32),
    is_rag BOOL NOT NULL DEFAULT 0,
    is_kb_head BOOL NOT NULL DEFAULT 0,
    chunks_count INTEGER,
    retrieval_count INTEGER,
    restricted_mode BOOL,
    hit BOOL,
    adopted BOOL,
    cited_count INTEGER,
    query_hash VARCHAR(64),
    duration_ms INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, event_id),
    INDEX ix_stage_query_kb_date (run_id, kb_id, stat_date),
    INDEX ix_stage_query_date_mode (run_id, stat_date, injection_mode),
    INDEX ix_stage_query_user_date (run_id, user_id, stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kb_stat_source_watermarks (
    source_name VARCHAR(128) NOT NULL,
    partition_key VARCHAR(255) NOT NULL DEFAULT 'global',
    last_source_id BIGINT,
    last_event_time DATETIME,
    last_successful_run_id BIGINT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (source_name, partition_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kb_stat_metric_watermarks (
    metric_name VARCHAR(128) NOT NULL,
    scope_key VARCHAR(255) NOT NULL DEFAULT 'admin',
    run_id BIGINT NOT NULL,
    stat_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'published',
    published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (metric_name, scope_key),
    INDEX ix_metric_watermark_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
