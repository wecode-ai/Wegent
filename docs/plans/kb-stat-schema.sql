-- =============================================================================
-- KB-Stat Schema (Full DDL) - Auto-generated from SQLAlchemy ORM metadata
-- Engine: MySQL 8.0+ / InnoDB / utf8mb4
-- Table/column/index counts are validated from ORM metadata during release.
-- Source: knowledge_engine/knowledge_engine/stat/models/
-- Equivalent to: alembic -c alembic.ini upgrade head (001..018)
-- Generated: 2026-07-23
--
-- Usage:
--   mysql -u <user> -p <db> < docs/plans/kb-stat-schema.sql
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- Table: kb_stat_runs  (12 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_runs (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	started_at DATETIME NOT NULL, 
	completed_at DATETIME, 
	status VARCHAR(20) NOT NULL, 
	target_date DATE NOT NULL, 
	kb_filter JSON, 
	triggered_by VARCHAR(32) NOT NULL, 
	triggered_user_id INTEGER, 
	error_message TEXT, 
	metrics_count INTEGER NOT NULL, 
	stat_start DATE COMMENT 'Data range start', 
	stat_end DATE COMMENT 'Data range end', 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_runs_started_at ON kb_stat_runs (started_at);
CREATE INDEX idx_runs_target_date ON kb_stat_runs (target_date, status);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_collector_runs  (10 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_collector_runs (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	run_id INTEGER NOT NULL, 
	domain VARCHAR(64) NOT NULL, 
	collector_name VARCHAR(128) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	started_at DATETIME NOT NULL, 
	completed_at DATETIME, 
	rows_written INTEGER NOT NULL, 
	duration_ms BIGINT NOT NULL DEFAULT 0,
	error_message TEXT, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX ix_kb_stat_collector_runs_run_id ON kb_stat_collector_runs (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_answer_adoption_rate  (10 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_answer_adoption_rate (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	total_queries INTEGER NOT NULL, 
	adopted_queries INTEGER NOT NULL, 
	adoption_rate FLOAT, 
	low_confidence INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_answer_adoption_kb ON kb_stat_answer_adoption_rate (kb_id);
CREATE INDEX idx_answer_adoption_run ON kb_stat_answer_adoption_rate (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_approval_efficiency  (9 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_approval_efficiency (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT, 
	avg_approval_minutes FLOAT, 
	total_requests INTEGER, 
	approved_count INTEGER, 
	approval_rate FLOAT, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_approval_eff_kb ON kb_stat_approval_efficiency (kb_id);
CREATE INDEX idx_approval_eff_run ON kb_stat_approval_efficiency (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_attachment_storage  (7 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_attachment_storage (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	storage_backend VARCHAR(64), 
	file_count INTEGER, 
	total_size BIGINT, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_attachment_storage_run ON kb_stat_attachment_storage (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_chunks_count_distribution  (6 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_chunks_count_distribution (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	chunk_bucket VARCHAR(32), 
	call_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_chunks_dist_run ON kb_stat_chunks_count_distribution (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_content_freshness  (6 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_content_freshness (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	freshness_bucket VARCHAR(32) NOT NULL, 
	doc_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_content_freshness_run ON kb_stat_content_freshness (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_cross_kb_query_user  (8 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_cross_kb_query_user (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	user_id BIGINT NOT NULL, 
	user_name VARCHAR(255), 
	kb_count INTEGER NOT NULL, 
	query_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_cross_kb_query_user_run ON kb_stat_cross_kb_query_user (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_cross_org_access  (10 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_cross_org_access (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT, 
	kb_namespace VARCHAR(128), 
	kb_name VARCHAR(255), 
	user_id BIGINT, 
	user_namespace VARCHAR(128), 
	`role` VARCHAR(64), 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_cross_org_kb ON kb_stat_cross_org_access (kb_id);
CREATE INDEX idx_cross_org_run ON kb_stat_cross_org_access (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_daily_dashboard  (15 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_daily_dashboard (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	total_queries INTEGER NOT NULL, 
	rag_queries INTEGER NOT NULL, 
	direct_injection INTEGER NOT NULL, 
	kb_head_rag_queries INTEGER NOT NULL, 
	kb_head_queries INTEGER NOT NULL, 
	active_kb_count INTEGER NOT NULL, 
	active_user_count INTEGER NOT NULL, 
	new_kb_count INTEGER NOT NULL, 
	new_doc_count INTEGER NOT NULL, 
	dingtalk_active_user_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_dashboard_date ON kb_stat_daily_dashboard (stat_date);
CREATE INDEX idx_dashboard_run ON kb_stat_daily_dashboard (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_chunk_count_distribution  (6 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_chunk_count_distribution (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	chunk_bucket VARCHAR(32) NOT NULL, 
	doc_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_chunk_count_dist_run ON kb_stat_doc_chunk_count_distribution (run_id);
-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_chunk_strategy  (7 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_chunk_strategy (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	splitter_type VARCHAR(64) NOT NULL, 
	file_extension VARCHAR(64) NOT NULL, 
	doc_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_chunk_strategy_run ON kb_stat_doc_chunk_strategy (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_folder_depth  (7 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_folder_depth (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	depth INTEGER NOT NULL, 
	folder_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_folder_depth_run ON kb_stat_doc_folder_depth (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_index_failure_rate  (8 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_index_failure_rate (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	file_extension VARCHAR(64) NOT NULL, 
	total_count INTEGER NOT NULL, 
	failed_count INTEGER NOT NULL, 
	failure_rate FLOAT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_index_failure_rate_run ON kb_stat_doc_index_failure_rate (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_index_status  (8 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_index_status (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	index_status VARCHAR(64) NOT NULL, 
	file_extension VARCHAR(64) NOT NULL, 
	kb_id BIGINT NOT NULL, 
	doc_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_index_status_run ON kb_stat_doc_index_status (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_index_storage_view  (9 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_index_storage_view (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	index_status VARCHAR(64), 
	file_extension VARCHAR(64), 
	doc_count INTEGER, 
	total_file_size BIGINT, 
	avg_file_size BIGINT, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_index_storage_run ON kb_stat_doc_index_storage_view (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_lifecycle_trace  (13 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_lifecycle_trace (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	document_id BIGINT, 
	document_name VARCHAR(255), 
	kb_id BIGINT, 
	file_extension VARCHAR(64), 
	index_status VARCHAR(64), 
	index_generation INTEGER, 
	file_size BIGINT, 
	created_at_doc DATETIME, 
	updated_at_doc DATETIME, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_lifecycle_run ON kb_stat_doc_lifecycle_trace (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_read_count  (8 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_read_count (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	document_id BIGINT NOT NULL, 
	document_name VARCHAR(255), 
	kb_id BIGINT NOT NULL, 
	read_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_read_run ON kb_stat_doc_read_count (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_reference_count  (10 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_reference_count (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	document_id BIGINT NOT NULL, 
	document_name VARCHAR(255), 
	kb_id BIGINT NOT NULL, 
	rag_ref_count INTEGER NOT NULL, 
	head_ref_count INTEGER NOT NULL, 
	total_ref_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_ref_run ON kb_stat_doc_reference_count (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_size_distribution  (7 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_size_distribution (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	size_bucket VARCHAR(32) NOT NULL, 
	doc_count INTEGER NOT NULL, 
	total_size BIGINT NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_size_distribution_run ON kb_stat_doc_size_distribution (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_summary_status  (6 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_summary_status (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	summary_status VARCHAR(64) NOT NULL, 
	doc_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_summary_status_run ON kb_stat_doc_summary_status (run_id);
-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_update_frequency  (8 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_update_frequency (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	file_extension VARCHAR(64) NOT NULL, 
	index_generation INTEGER NOT NULL, 
	doc_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_update_frequency_run ON kb_stat_doc_update_frequency (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_upload_trend  (10 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_upload_trend (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	file_extension VARCHAR(64) NOT NULL, 
	source_type VARCHAR(64) NOT NULL, 
	user_id BIGINT NOT NULL, 
	upload_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_upload_trend_date ON kb_stat_doc_upload_trend (stat_date);
CREATE INDEX idx_doc_upload_trend_run ON kb_stat_doc_upload_trend (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_uploader_ranking  (7 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_uploader_ranking (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	user_id BIGINT, 
	user_name VARCHAR(255), 
	upload_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_uploader_ranking_run ON kb_stat_doc_uploader_ranking (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_doc_value_ranking  (12 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_doc_value_ranking (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	document_id BIGINT, 
	document_name VARCHAR(255), 
	kb_id BIGINT, 
	rag_ref_count INTEGER, 
	head_ref_count INTEGER, 
	unique_users INTEGER, 
	days_since_update INTEGER, 
	value_score FLOAT, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_doc_value_run ON kb_stat_doc_value_ranking (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_duplicate_doc_suspect  (8 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_duplicate_doc_suspect (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	total_docs INTEGER NOT NULL, 
	duplicate_docs INTEGER NOT NULL, 
	duplicate_rate FLOAT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_duplicate_doc_kb ON kb_stat_duplicate_doc_suspect (kb_id);
CREATE INDEX idx_duplicate_doc_run ON kb_stat_duplicate_doc_suspect (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_global_totals  (9 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_global_totals (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	total_kb_count INTEGER NOT NULL, 
	total_doc_count INTEGER NOT NULL, 
	dingtalk_synced_user_count INTEGER NOT NULL, 
	dingtalk_kb_count INTEGER NOT NULL, 
	dingtalk_doc_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (run_id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_global_totals_run ON kb_stat_global_totals (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_invitation_chain  (10 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_invitation_chain (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	inviter_id BIGINT, 
	inviter_name VARCHAR(255), 
	invitee_id BIGINT, 
	invitee_name VARCHAR(255), 
	`role` VARCHAR(64), 
	kb_id BIGINT, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_invitation_chain_run ON kb_stat_invitation_chain (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_abandon_rate  (10 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_abandon_rate (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	namespace VARCHAR(128), 
	total_kb_count INTEGER NOT NULL, 
	stale_kb_count INTEGER NOT NULL, 
	inactive_kb_count INTEGER NOT NULL, 
	abandon_rate FLOAT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_abandon_run ON kb_stat_kb_abandon_rate (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_active_users  (10 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_active_users (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	user_id BIGINT NOT NULL, 
	user_name VARCHAR(255), 
	rag_count INTEGER NOT NULL, 
	head_count INTEGER NOT NULL, 
	total_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_active_users_kb ON kb_stat_kb_active_users (kb_id);
CREATE INDEX idx_kb_active_users_run ON kb_stat_kb_active_users (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_activity  (12 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_activity (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	kb_namespace VARCHAR(128), 
	kb_name VARCHAR(255), 
	document_count INTEGER, 
	last_doc_uploaded_at DATETIME, 
	last_query_at DATETIME, 
	is_stale INTEGER, 
	is_inactive INTEGER, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_activity_kb ON kb_stat_kb_activity (kb_id, target_date);
CREATE INDEX idx_activity_run ON kb_stat_kb_activity (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_avg_doc_length  (8 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_avg_doc_length (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	total_docs INTEGER NOT NULL, 
	avg_doc_length FLOAT, 
	median_doc_length FLOAT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_avg_doc_length_kb ON kb_stat_kb_avg_doc_length (kb_id);
CREATE INDEX idx_kb_avg_doc_length_run ON kb_stat_kb_avg_doc_length (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_config_sanity  (9 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_config_sanity (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	kb_name VARCHAR(255), 
	issue_type VARCHAR(64) NOT NULL, 
	issue_detail VARCHAR(255), 
	config_value VARCHAR(128), 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_config_sanity_kb ON kb_stat_kb_config_sanity (kb_id);
CREATE INDEX idx_config_sanity_run ON kb_stat_kb_config_sanity (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_content_freshness  (8 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_content_freshness (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	total_docs INTEGER NOT NULL, 
	fresh_docs INTEGER NOT NULL, 
	fresh_rate FLOAT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_content_freshness_kb ON kb_stat_kb_content_freshness (kb_id);
CREATE INDEX idx_kb_content_freshness_run ON kb_stat_kb_content_freshness (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_creation_trend  (8 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_creation_trend (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	namespace VARCHAR(128), 
	new_kb_count INTEGER NOT NULL, 
	cumulative_kb_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_creation_date ON kb_stat_kb_creation_trend (stat_date);
CREATE INDEX idx_creation_run ON kb_stat_kb_creation_trend (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_creator_ranking  (7 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_creator_ranking (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	user_id BIGINT, 
	user_name VARCHAR(255), 
	kb_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_creator_ranking_run ON kb_stat_kb_creator_ranking (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_daily_stats  (11 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_daily_stats (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	total_queries INTEGER NOT NULL,
	rag_queries INTEGER NOT NULL, 
	head_queries INTEGER NOT NULL, 
	direct_injection INTEGER NOT NULL, 
	active_user_count INTEGER NOT NULL, 
	new_doc_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_daily_stats_kb_date ON kb_stat_kb_daily_stats (kb_id, stat_date);
CREATE INDEX idx_kb_daily_stats_run ON kb_stat_kb_daily_stats (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_growth_curve  (9 cols, 3 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_growth_curve (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT, 
	kb_name VARCHAR(255), 
	stat_date DATE, 
	cumulative_docs INTEGER, 
	cumulative_members INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_growth_curve_date ON kb_stat_kb_growth_curve (stat_date);
CREATE INDEX idx_growth_curve_kb ON kb_stat_kb_growth_curve (kb_id);
CREATE INDEX idx_growth_curve_run ON kb_stat_kb_growth_curve (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_head_frequency  (8 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_head_frequency (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	kb_name VARCHAR(255), 
	call_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_head_freq_date ON kb_stat_kb_head_frequency (stat_date);
CREATE INDEX idx_kb_head_freq_run ON kb_stat_kb_head_frequency (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_health_score  (14 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_health_score (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT, 
	kb_name VARCHAR(255), 
	namespace VARCHAR(128), 
	activity_score FLOAT, 
	index_success_score FLOAT, 
	enable_score FLOAT, 
	summary_score FLOAT, 
	health_score FLOAT, 
	formula_version VARCHAR(16) NOT NULL DEFAULT 'v1', 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_health_score_kb ON kb_stat_kb_health_score (kb_id);
CREATE INDEX idx_health_score_run ON kb_stat_kb_health_score (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_member_scale  (6 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_member_scale (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	scale_bucket VARCHAR(32), 
	kb_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_member_scale_run ON kb_stat_kb_member_scale (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_rag_head_ratio  (9 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_rag_head_ratio (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	rag_count INTEGER NOT NULL, 
	head_count INTEGER NOT NULL, 
	rag_ratio FLOAT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_rag_head_ratio_date ON kb_stat_kb_rag_head_ratio (stat_date);
CREATE INDEX idx_kb_rag_head_ratio_run ON kb_stat_kb_rag_head_ratio (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_retrieval_config  (8 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_retrieval_config (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	retrieval_mode VARCHAR(64), 
	top_k INTEGER, 
	score_threshold FLOAT, 
	kb_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_retrieval_config_run ON kb_stat_kb_retrieval_config (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_retrieval_hit_rate  (10 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_retrieval_hit_rate (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	total_queries INTEGER NOT NULL, 
	hit_queries INTEGER NOT NULL, 
	hit_rate FLOAT, 
	low_confidence INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_hit_rate_kb ON kb_stat_kb_retrieval_hit_rate (kb_id);
CREATE INDEX idx_kb_hit_rate_run ON kb_stat_kb_retrieval_hit_rate (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_retrieval_mode_dist  (7 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_retrieval_mode_dist (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	injection_mode VARCHAR(64), 
	call_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_ret_mode_kb ON kb_stat_kb_retrieval_mode_dist (kb_id);
CREATE INDEX idx_kb_ret_mode_run ON kb_stat_kb_retrieval_mode_dist (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_sharing  (13 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_sharing (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	kb_name VARCHAR(255), 
	member_count INTEGER NOT NULL, 
	share_link_count INTEGER NOT NULL, 
	owner_count INTEGER NOT NULL, 
	maintainer_count INTEGER NOT NULL, 
	developer_count INTEGER NOT NULL, 
	reporter_count INTEGER NOT NULL, 
	restricted_analyst_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_sharing_kb ON kb_stat_kb_sharing (kb_id);
CREATE INDEX idx_sharing_run ON kb_stat_kb_sharing (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_size_distribution  (13 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_size_distribution (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	kb_name VARCHAR(255), 
	namespace VARCHAR(128), 
	doc_count INTEGER NOT NULL, 
	total_file_size BIGINT NOT NULL, 
	avg_file_size BIGINT, 
	max_file_size BIGINT, 
	size_bucket VARCHAR(32), 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_size_dist_kb ON kb_stat_kb_size_distribution (kb_id);
CREATE INDEX idx_size_dist_run ON kb_stat_kb_size_distribution (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_topic_distribution  (6 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_topic_distribution (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	topic VARCHAR(255), 
	kb_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_topic_dist_run ON kb_stat_kb_topic_distribution (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_zero_chunk_rate  (10 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_zero_chunk_rate (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	total_queries INTEGER NOT NULL, 
	zero_chunk_queries INTEGER NOT NULL, 
	zero_chunk_rate FLOAT, 
	low_confidence INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_zero_chunk_kb ON kb_stat_kb_zero_chunk_rate (kb_id);
CREATE INDEX idx_kb_zero_chunk_run ON kb_stat_kb_zero_chunk_rate (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_period_totals  (12 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_period_totals (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	start_date DATE NOT NULL, 
	end_date DATE NOT NULL, 
	period_total_queries INTEGER NOT NULL, 
	period_new_kb INTEGER NOT NULL, 
	period_new_docs INTEGER NOT NULL, 
	period_rag_queries INTEGER NOT NULL, 
	period_direct_inject INTEGER NOT NULL, 
	period_kb_head_queries INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_period_totals_run ON kb_stat_period_totals (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_permission_change_trend  (8 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_permission_change_trend (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE, 
	`role` VARCHAR(64), 
	status VARCHAR(64), 
	change_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_perm_change_date ON kb_stat_permission_change_trend (stat_date);
CREATE INDEX idx_perm_change_run ON kb_stat_permission_change_trend (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_prom_active_conversions  (5 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_prom_active_conversions (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	active_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_prom_active_run ON kb_stat_prom_active_conversions (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_prom_callback_success_rate  (8 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_prom_callback_success_rate (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	callback_type VARCHAR(64), 
	total_count INTEGER, 
	success_count INTEGER, 
	success_rate FLOAT, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_prom_callback_run ON kb_stat_prom_callback_success_rate (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_prom_conversion_duration  (8 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_prom_conversion_duration (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	file_extension VARCHAR(64), 
	p50_seconds FLOAT, 
	p90_seconds FLOAT, 
	p99_seconds FLOAT, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_prom_conv_dur_run ON kb_stat_prom_conversion_duration (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_prom_conversion_success_rate  (8 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_prom_conversion_success_rate (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	file_extension VARCHAR(64), 
	success_rate FLOAT, 
	total_count INTEGER, 
	success_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_prom_conv_rate_run ON kb_stat_prom_conversion_success_rate (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_rag_call_frequency  (8 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_rag_call_frequency (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	kb_name VARCHAR(255), 
	call_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_rag_call_freq_date ON kb_stat_rag_call_frequency (stat_date);
CREATE INDEX idx_rag_call_freq_run ON kb_stat_rag_call_frequency (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_rag_call_limit  (7 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_rag_call_limit (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	max_calls_config INTEGER, 
	hit_limit_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_rag_call_limit_kb ON kb_stat_rag_call_limit (kb_id);
CREATE INDEX idx_rag_call_limit_run ON kb_stat_rag_call_limit (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_rag_head_verify_rate  (9 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_rag_head_verify_rate (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE, 
	kb_id BIGINT, 
	total_rag_calls INTEGER, 
	verified_by_head INTEGER, 
	verify_rate FLOAT, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_rag_head_date ON kb_stat_rag_head_verify_rate (stat_date);
CREATE INDEX idx_rag_head_run ON kb_stat_rag_head_verify_rate (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_rag_vs_head_ratio  (8 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_rag_vs_head_ratio (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	rag_count INTEGER NOT NULL, 
	head_count INTEGER NOT NULL, 
	rag_ratio FLOAT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_rag_vs_head_date ON kb_stat_rag_vs_head_ratio (stat_date);
CREATE INDEX idx_rag_vs_head_run ON kb_stat_rag_vs_head_ratio (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_restricted_analyst_usage  (6 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_restricted_analyst_usage (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT, 
	analyst_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_restricted_analyst_kb ON kb_stat_restricted_analyst_usage (kb_id);
CREATE INDEX idx_restricted_analyst_run ON kb_stat_restricted_analyst_usage (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_restricted_mode_usage  (8 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_restricted_mode_usage (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	total_calls INTEGER NOT NULL, 
	restricted_calls INTEGER NOT NULL, 
	restricted_rate FLOAT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_restricted_usage_kb ON kb_stat_restricted_mode_usage (kb_id);
CREATE INDEX idx_restricted_usage_run ON kb_stat_restricted_mode_usage (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_retrieval_active_user  (10 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_retrieval_active_user (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	user_id BIGINT, 
	user_name VARCHAR(255), 
	rag_count INTEGER, 
	head_count INTEGER, 
	total_count INTEGER, 
	user_tier VARCHAR(32), 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_retrieval_active_user_run ON kb_stat_retrieval_active_user (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_retrieval_mode_distribution  (6 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_retrieval_mode_distribution (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	injection_mode VARCHAR(64), 
	call_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_retrieval_mode_run ON kb_stat_retrieval_mode_distribution (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_selected_documents_usage  (7 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_selected_documents_usage (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	document_id BIGINT NOT NULL, 
	select_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_selected_docs_run ON kb_stat_selected_documents_usage (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_share_link_usage  (11 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_share_link_usage (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT, 
	kb_name VARCHAR(255), 
	link_count INTEGER, 
	total_joins INTEGER, 
	avg_joins_per_link FLOAT, 
	needs_approval INTEGER, 
	no_approval INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_share_link_kb ON kb_stat_share_link_usage (kb_id);
CREATE INDEX idx_share_link_run ON kb_stat_share_link_usage (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_storage_usage  (9 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_storage_usage (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT, 
	kb_name VARCHAR(255), 
	namespace VARCHAR(128), 
	total_file_size BIGINT, 
	doc_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_storage_usage_kb ON kb_stat_storage_usage (kb_id);
CREATE INDEX idx_storage_usage_run ON kb_stat_storage_usage (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_kb_thin_doc_rate  (9 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_kb_thin_doc_rate (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	stat_date DATE NOT NULL, 
	kb_id BIGINT NOT NULL, 
	total_docs INTEGER NOT NULL, 
	thin_docs INTEGER NOT NULL, 
	thin_doc_rate FLOAT, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_kb_thin_doc_rate_kb ON kb_stat_kb_thin_doc_rate (kb_id);
CREATE INDEX idx_kb_thin_doc_rate_run ON kb_stat_kb_thin_doc_rate (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_user_first_kb_usage  (9 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_user_first_kb_usage (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	user_id BIGINT, 
	user_name VARCHAR(255), 
	registered_at DATETIME, 
	first_kb_usage_at DATETIME, 
	days_to_first FLOAT, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_user_first_kb_usage_run ON kb_stat_user_first_kb_usage (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_user_kb_binding  (7 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_user_kb_binding (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	kb_id BIGINT, 
	kb_name VARCHAR(255), 
	task_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_user_kb_binding_kb ON kb_stat_user_kb_binding (kb_id);
CREATE INDEX idx_user_kb_binding_run ON kb_stat_user_kb_binding (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_user_participation_summary  (11 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_user_participation_summary (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	user_id BIGINT, 
	user_name VARCHAR(255), 
	is_creator INTEGER, 
	is_uploader INTEGER, 
	is_retriever INTEGER, 
	is_member INTEGER, 
	participation_type VARCHAR(64), 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_user_participation_run ON kb_stat_user_participation_summary (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_user_pattern_evolution  (10 cols, 2 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_user_pattern_evolution (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	user_id BIGINT, 
	user_name VARCHAR(255), 
	stat_month VARCHAR(7), 
	rag_count INTEGER, 
	head_count INTEGER, 
	rag_ratio FLOAT, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_user_pattern_month ON kb_stat_user_pattern_evolution (stat_month);
CREATE INDEX idx_user_pattern_run ON kb_stat_user_pattern_evolution (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_user_permission_distribution  (6 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_user_permission_distribution (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	`role` VARCHAR(64), 
	user_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_user_perm_dist_run ON kb_stat_user_permission_distribution (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_user_rag_head_preference  (9 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_user_rag_head_preference (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	user_id BIGINT, 
	user_name VARCHAR(255), 
	rag_count INTEGER, 
	head_count INTEGER, 
	preference VARCHAR(32), 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_user_rag_head_pref_run ON kb_stat_user_rag_head_preference (run_id);

-- -----------------------------------------------------------------------------
-- Table: kb_stat_user_segmentation  (6 cols, 1 idx)
-- -----------------------------------------------------------------------------
CREATE TABLE kb_stat_user_segmentation (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	run_id BIGINT NOT NULL, 
	target_date DATE NOT NULL, 
	segment VARCHAR(64), 
	user_count INTEGER, 
	created_at DATETIME, 
	PRIMARY KEY (id)
)CHARSET=utf8mb4 ENGINE=InnoDB COLLATE utf8mb4_unicode_ci;
CREATE INDEX idx_user_seg_run ON kb_stat_user_segmentation (run_id);

-- -----------------------------------------------------------------------------
-- Composite optimization indexes (migrations 011 + 016)
-- -----------------------------------------------------------------------------
CREATE INDEX `ix_health_score_rank` ON `kb_stat_kb_health_score` (`run_id`, `health_score`);
CREATE INDEX `ix_doc_value_rank` ON `kb_stat_doc_value_ranking` (`run_id`, `value_score`);
CREATE INDEX `ix_zero_chunk_alert` ON `kb_stat_kb_zero_chunk_rate` (`run_id`, `zero_chunk_rate`);
CREATE INDEX `ix_kb_thin_doc_rate` ON `kb_stat_kb_thin_doc_rate` (`run_id`, `thin_doc_rate`);
CREATE INDEX `ix_daily_dashboard_date_run` ON `kb_stat_daily_dashboard` (`stat_date`, `run_id`);
CREATE INDEX `ix_abandon_rate_rank` ON `kb_stat_kb_abandon_rate` (`run_id`, `abandon_rate`);
CREATE INDEX `ix_storage_usage_rank` ON `kb_stat_storage_usage` (`run_id`, `total_file_size`);
CREATE INDEX `ix_doc_ref_rank` ON `kb_stat_doc_reference_count` (`run_id`, `total_ref_count`);
CREATE INDEX `ix_doc_read_rank` ON `kb_stat_doc_read_count` (`run_id`, `read_count`);
CREATE INDEX `ix_health_score_target_run` ON `kb_stat_kb_health_score` (`target_date`, `run_id`);
CREATE INDEX `ix_zero_chunk_target_run` ON `kb_stat_kb_zero_chunk_rate` (`target_date`, `run_id`);
CREATE INDEX `ix_hit_rate_target_run` ON `kb_stat_kb_retrieval_hit_rate` (`target_date`, `run_id`);
CREATE INDEX `ix_adoption_target_run` ON `kb_stat_answer_adoption_rate` (`target_date`, `run_id`);
CREATE INDEX `ix_runs_status` ON `kb_stat_runs` (`status`);

SET FOREIGN_KEY_CHECKS = 1;

