-- Rename the retained thin-document metric in the statistics database.
-- The obsolete orphan table is intentionally left untouched so deployment is
-- non-destructive; it can be archived or dropped in a later maintenance window.
RENAME TABLE kb_stat_thin_doc_alert TO kb_stat_kb_thin_doc_rate;

ALTER TABLE kb_stat_kb_thin_doc_rate
    RENAME INDEX idx_thin_doc_kb TO idx_kb_thin_doc_rate_kb,
    RENAME INDEX idx_thin_doc_run TO idx_kb_thin_doc_rate_run,
    RENAME INDEX ix_thin_doc_alert TO ix_kb_thin_doc_rate;
