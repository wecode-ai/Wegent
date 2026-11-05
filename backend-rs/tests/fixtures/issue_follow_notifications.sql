CREATE TABLE wework_notifications (
    id VARCHAR(36) PRIMARY KEY, user_id INT NOT NULL, actor_user_id INT NOT NULL,
    kind VARCHAR(64) NOT NULL, title VARCHAR(256) NOT NULL, body TEXT NOT NULL,
    url VARCHAR(2048) NOT NULL, payload JSON NOT NULL, created_at DATETIME NOT NULL,
    is_read BOOLEAN NOT NULL, read_status_changed_at DATETIME NOT NULL
) ENGINE=InnoDB
