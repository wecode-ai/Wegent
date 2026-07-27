ALTER TABLE kb_stat_kb_thin_doc_rate
    RENAME INDEX idx_kb_thin_doc_rate_kb TO idx_thin_doc_kb,
    RENAME INDEX idx_kb_thin_doc_rate_run TO idx_thin_doc_run,
    RENAME INDEX ix_kb_thin_doc_rate TO ix_thin_doc_alert;

RENAME TABLE kb_stat_kb_thin_doc_rate TO kb_stat_thin_doc_alert;
