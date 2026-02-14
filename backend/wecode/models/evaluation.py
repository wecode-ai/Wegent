# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Evaluation module database models.

This module defines all database tables for the evaluation system:
- Topics: Examination topics/categories
- Questions: Individual questions within topics
- Answers: User submissions/responses
- Grading Tasks: AI-powered grading tasks
- Permissions: Access control for topics

All tables use the 'wecode_eval_' prefix for isolation from core tables.

Database DDL (MySQL):
=====================

CREATE TABLE `wecode_eval_topics` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Primary key ID',
  `name` varchar(200) NOT NULL DEFAULT '' COMMENT 'Topic name',
  `creator_id` int NOT NULL DEFAULT '0' COMMENT 'Creator user ID',
  `visibility` varchar(20) NOT NULL DEFAULT 'private' COMMENT 'Visibility: public/private',
  `status` int NOT NULL DEFAULT '0' COMMENT 'Status: 0=draft, 1=published',
  `current_version` varchar(25) NOT NULL DEFAULT '' COMMENT 'Current published version',
  `extra_data` json NOT NULL COMMENT 'Extra data (description, etc.)',
  `grading_team_config` json NOT NULL COMMENT 'Grading team configuration',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
  `is_active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'Active flag (soft delete)',
  PRIMARY KEY (`id`),
  KEY `idx_wecode_eval_topics_creator` (`creator_id`),
  KEY `idx_wecode_eval_topics_visibility` (`visibility`),
  KEY `idx_wecode_eval_topics_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `wecode_eval_topic_versions` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Primary key ID',
  `topic_id` int NOT NULL DEFAULT '0' COMMENT 'Related topic ID',
  `version` varchar(25) NOT NULL DEFAULT '' COMMENT 'Version string',
  `question_snapshots` json NOT NULL COMMENT 'Question version snapshots',
  `published_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Publication time',
  `published_by` int NOT NULL DEFAULT '0' COMMENT 'Publisher user ID',
  PRIMARY KEY (`id`),
  KEY `idx_wecode_eval_topic_versions_topic` (`topic_id`),
  KEY `idx_wecode_eval_topic_versions_version` (`topic_id`,`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `wecode_eval_questions` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Primary key ID',
  `topic_id` int NOT NULL DEFAULT '0' COMMENT 'Related topic ID',
  `title` varchar(500) NOT NULL DEFAULT '' COMMENT 'Question title',
  `content_type` varchar(20) NOT NULL DEFAULT 'text' COMMENT 'Content type: text/url/attachment/mixed',
  `content_data` json NOT NULL COMMENT 'Question content data',
  `status` int NOT NULL DEFAULT '0' COMMENT 'Status: 0=draft, 1=published',
  `current_version` varchar(25) NOT NULL DEFAULT '' COMMENT 'Current published version',
  `order_index` int NOT NULL DEFAULT '0' COMMENT 'Sort order index',
  `creator_id` int NOT NULL DEFAULT '0' COMMENT 'Creator user ID',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
  `is_active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'Active flag (soft delete)',
  PRIMARY KEY (`id`),
  KEY `idx_wecode_eval_questions_topic` (`topic_id`),
  KEY `idx_wecode_eval_questions_creator` (`creator_id`),
  KEY `idx_wecode_eval_questions_order` (`topic_id`,`order_index`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `wecode_eval_question_versions` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Primary key ID',
  `question_id` int NOT NULL DEFAULT '0' COMMENT 'Related question ID',
  `version` varchar(25) NOT NULL DEFAULT '' COMMENT 'Version string',
  `content_data` json NOT NULL COMMENT 'Question content snapshot',
  `criteria_data` json NOT NULL COMMENT 'Grading criteria data',
  `published_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Publication time',
  `published_by` int NOT NULL DEFAULT '0' COMMENT 'Publisher user ID',
  PRIMARY KEY (`id`),
  KEY `idx_wecode_eval_question_versions_question` (`question_id`),
  KEY `idx_wecode_eval_question_versions_ver` (`question_id`,`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `wecode_eval_permissions` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Primary key ID',
  `topic_id` int NOT NULL DEFAULT '0' COMMENT 'Related topic ID',
  `user_id` int NOT NULL DEFAULT '0' COMMENT 'Authorized user ID',
  `role` varchar(20) NOT NULL DEFAULT 'respondent' COMMENT 'Role: respondent/grader',
  `granted_by` int NOT NULL DEFAULT '0' COMMENT 'Granter user ID',
  `granted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Grant time',
  PRIMARY KEY (`id`),
  KEY `idx_wecode_eval_permissions_topic` (`topic_id`),
  KEY `idx_wecode_eval_permissions_user` (`user_id`),
  KEY `idx_wecode_eval_permissions_topic_user` (`topic_id`,`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `wecode_eval_answers` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Primary key ID',
  `question_id` int NOT NULL DEFAULT '0' COMMENT 'Related question ID',
  `question_version` varchar(25) NOT NULL DEFAULT '' COMMENT 'Question version at submission time',
  `respondent_id` int NOT NULL DEFAULT '0' COMMENT 'Respondent user ID',
  `content_type` varchar(20) NOT NULL DEFAULT 'text' COMMENT 'Content type: text/url/attachment/mixed',
  `content_data` json NOT NULL COMMENT 'Answer content data',
  `submitted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Submission time',
  `is_latest` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'Is latest submission',
  PRIMARY KEY (`id`),
  KEY `idx_wecode_eval_answers_question` (`question_id`),
  KEY `idx_wecode_eval_answers_respondent` (`respondent_id`),
  KEY `idx_wecode_eval_answers_question_respondent` (`question_id`,`respondent_id`),
  KEY `idx_wecode_eval_answers_latest` (`question_id`,`respondent_id`,`is_latest`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `wecode_eval_grading_tasks` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Primary key ID',
  `answer_id` int NOT NULL DEFAULT '0' COMMENT 'Related answer ID',
  `question_id` int NOT NULL DEFAULT '0' COMMENT 'Related question ID',
  `question_version` varchar(25) NOT NULL DEFAULT '' COMMENT 'Question version for grading',
  `respondent_id` int NOT NULL DEFAULT '0' COMMENT 'Respondent user ID',
  `grader_id` int NOT NULL DEFAULT '0' COMMENT 'Grader user ID',
  `team_id` int NOT NULL DEFAULT '0' COMMENT 'Wegent Team ID for AI grading',
  `task_id` int NOT NULL DEFAULT '0' COMMENT 'Wegent Task ID',
  `status` int NOT NULL DEFAULT '0' COMMENT 'Status: 0=pending, 1=running, 2=completed, 3=failed, 4=published',
  `executor_id` varchar(64) NOT NULL DEFAULT '' COMMENT 'Executor instance ID for CAS protection',
  `attempt_count` int NOT NULL DEFAULT '0' COMMENT 'Execution attempt count for retry logic',
  `error_message` varchar(2000) NOT NULL DEFAULT '' COMMENT 'Error message when failed',
  `report_data` json NOT NULL COMMENT 'Grading report data',
  `report_s3_path` varchar(500) NOT NULL DEFAULT '' COMMENT 'Report S3 storage path',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation time',
  `started_at` datetime NOT NULL DEFAULT '1970-01-01 00:00:00' COMMENT 'Grading start time',
  `completed_at` datetime NOT NULL DEFAULT '1970-01-01 00:00:00' COMMENT 'Grading completion time',
  `published_at` datetime NOT NULL DEFAULT '1970-01-01 00:00:00' COMMENT 'Report publication time',
  PRIMARY KEY (`id`),
  KEY `idx_wecode_eval_grading_tasks_answer` (`answer_id`),
  KEY `idx_wecode_eval_grading_tasks_question` (`question_id`),
  KEY `idx_wecode_eval_grading_tasks_respondent` (`respondent_id`),
  KEY `idx_wecode_eval_grading_tasks_status` (`status`),
  KEY `idx_wecode_eval_grading_tasks_task` (`task_id`),
  KEY `idx_wecode_eval_grading_tasks_grader` (`grader_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Migration SQL for existing tables (add new columns to wecode_eval_grading_tasks):
-- ALTER TABLE `wecode_eval_grading_tasks`
--   ADD COLUMN `executor_id` varchar(64) NOT NULL DEFAULT '' COMMENT 'Executor instance ID for CAS protection' AFTER `status`,
--   ADD COLUMN `attempt_count` int NOT NULL DEFAULT '0' COMMENT 'Execution attempt count for retry logic' AFTER `executor_id`,
--   ADD COLUMN `error_message` varchar(2000) NOT NULL DEFAULT '' COMMENT 'Error message when failed' AFTER `attempt_count`,
--   ADD INDEX `idx_wecode_eval_grading_tasks_grader` (`grader_id`);
"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, Index, Integer, String, text

from app.db.base import Base


class EvalTopic(Base):
    """
    Evaluation topic model.

    A topic represents an examination subject or category that contains
    multiple questions. Topics can be public or private, and support
    versioning for content management.
    """

    __tablename__ = "wecode_eval_topics"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True,
        comment="Primary key ID",
    )
    name = Column(String(200), nullable=False, server_default="", comment="Topic name")
    creator_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Creator user ID",
    )
    visibility = Column(
        String(20),
        nullable=False,
        server_default="private",
        comment="Visibility: public/private",
    )
    status = Column(
        Integer,
        nullable=False,
        server_default="0",
        comment="Status: 0=draft, 1=published",
    )
    current_version = Column(
        String(25),
        nullable=False,
        server_default="",
        comment="Current published version",
    )
    extra_data = Column(
        JSON, nullable=False, default=dict, comment="Extra data (description, etc.)"
    )
    grading_team_config = Column(
        JSON, nullable=False, default=dict, comment="Grading team configuration"
    )
    created_at = Column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        comment="Creation time",
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        onupdate=datetime.now,
        comment="Update time",
    )
    is_active = Column(
        Boolean,
        nullable=False,
        server_default="1",
        comment="Active flag (soft delete)",
    )

    __table_args__ = (
        Index("idx_wecode_eval_topics_creator", "creator_id"),
        Index("idx_wecode_eval_topics_visibility", "visibility"),
        Index("idx_wecode_eval_topics_status", "status"),
        {"mysql_charset": "utf8mb4"},
    )


class EvalTopicVersion(Base):
    """
    Topic version model.

    Records published versions of a topic, including snapshots
    of all question versions at the time of publication.
    """

    __tablename__ = "wecode_eval_topic_versions"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True,
        comment="Primary key ID",
    )
    topic_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Related topic ID",
    )
    version = Column(
        String(25), nullable=False, server_default="", comment="Version string"
    )
    question_snapshots = Column(
        JSON, nullable=False, default=list, comment="Question version snapshots"
    )
    published_at = Column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        comment="Publication time",
    )
    published_by = Column(
        Integer, nullable=False, server_default="0", comment="Publisher user ID"
    )

    __table_args__ = (
        Index("idx_wecode_eval_topic_versions_topic", "topic_id"),
        Index("idx_wecode_eval_topic_versions_version", "topic_id", "version"),
        {"mysql_charset": "utf8mb4"},
    )


class EvalQuestion(Base):
    """
    Evaluation question model.

    A question belongs to a topic and supports multiple content types
    including text, URL, attachments, or a combination (mixed).
    """

    __tablename__ = "wecode_eval_questions"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True,
        comment="Primary key ID",
    )
    topic_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Related topic ID",
    )
    title = Column(
        String(500), nullable=False, server_default="", comment="Question title"
    )
    content_type = Column(
        String(20),
        nullable=False,
        server_default="text",
        comment="Content type: text/url/attachment/mixed",
    )
    content_data = Column(
        JSON, nullable=False, default=dict, comment="Question content data"
    )
    status = Column(
        Integer,
        nullable=False,
        server_default="0",
        comment="Status: 0=draft, 1=published",
    )
    current_version = Column(
        String(25),
        nullable=False,
        server_default="",
        comment="Current published version",
    )
    order_index = Column(
        Integer, nullable=False, server_default="0", comment="Sort order index"
    )
    creator_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Creator user ID",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        comment="Creation time",
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        onupdate=datetime.now,
        comment="Update time",
    )
    is_active = Column(
        Boolean,
        nullable=False,
        server_default="1",
        comment="Active flag (soft delete)",
    )

    __table_args__ = (
        Index("idx_wecode_eval_questions_topic", "topic_id"),
        Index("idx_wecode_eval_questions_creator", "creator_id"),
        Index("idx_wecode_eval_questions_order", "topic_id", "order_index"),
        {"mysql_charset": "utf8mb4"},
    )


class EvalQuestionVersion(Base):
    """
    Question version model.

    Records published versions of a question, including both
    content data and grading criteria at the time of publication.
    """

    __tablename__ = "wecode_eval_question_versions"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True,
        comment="Primary key ID",
    )
    question_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Related question ID",
    )
    version = Column(
        String(25), nullable=False, server_default="", comment="Version string"
    )
    content_data = Column(
        JSON, nullable=False, default=dict, comment="Question content snapshot"
    )
    criteria_data = Column(
        JSON, nullable=False, default=dict, comment="Grading criteria data"
    )
    published_at = Column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        comment="Publication time",
    )
    published_by = Column(
        Integer, nullable=False, server_default="0", comment="Publisher user ID"
    )

    __table_args__ = (
        Index("idx_wecode_eval_question_versions_question", "question_id"),
        Index("idx_wecode_eval_question_versions_ver", "question_id", "version"),
        {"mysql_charset": "utf8mb4"},
    )


class EvalPermission(Base):
    """
    Evaluation permission model.

    Manages access control for private topics. Users can be granted
    respondent (can answer) or grader (can grade) roles.
    """

    __tablename__ = "wecode_eval_permissions"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True,
        comment="Primary key ID",
    )
    topic_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Related topic ID",
    )
    user_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Authorized user ID",
    )
    role = Column(
        String(20),
        nullable=False,
        server_default="respondent",
        comment="Role: respondent/grader",
    )
    granted_by = Column(
        Integer, nullable=False, server_default="0", comment="Granter user ID"
    )
    granted_at = Column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        comment="Grant time",
    )

    __table_args__ = (
        Index("idx_wecode_eval_permissions_topic", "topic_id"),
        Index("idx_wecode_eval_permissions_user", "user_id"),
        Index("idx_wecode_eval_permissions_topic_user", "topic_id", "user_id"),
        {"mysql_charset": "utf8mb4"},
    )


class EvalAnswer(Base):
    """
    Evaluation answer model.

    Records user submissions/responses to questions. Tracks which
    question version was active when the answer was submitted.
    """

    __tablename__ = "wecode_eval_answers"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True,
        comment="Primary key ID",
    )
    question_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Related question ID",
    )
    question_version = Column(
        String(25),
        nullable=False,
        server_default="",
        comment="Question version at submission time",
    )
    respondent_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Respondent user ID",
    )
    content_type = Column(
        String(20),
        nullable=False,
        server_default="text",
        comment="Content type: text/url/attachment/mixed",
    )
    content_data = Column(
        JSON, nullable=False, default=dict, comment="Answer content data"
    )
    submitted_at = Column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        comment="Submission time",
    )
    is_latest = Column(
        Boolean,
        nullable=False,
        server_default="1",
        comment="Is latest submission",
    )

    __table_args__ = (
        Index("idx_wecode_eval_answers_question", "question_id"),
        Index("idx_wecode_eval_answers_respondent", "respondent_id"),
        Index(
            "idx_wecode_eval_answers_question_respondent",
            "question_id",
            "respondent_id",
        ),
        Index(
            "idx_wecode_eval_answers_latest",
            "question_id",
            "respondent_id",
            "is_latest",
        ),
        {"mysql_charset": "utf8mb4"},
    )


class EvalGradingTask(Base):
    """
    Evaluation grading task model.

    Represents a grading task for a specific answer. Can be executed
    by an AI team (via Wegent Task) or manually by a grader.

    Status values:
    - 0: pending (waiting to be processed)
    - 1: running (AI grading in progress)
    - 2: completed (grading finished, draft report ready)
    - 3: failed (grading failed)
    - 4: published (report published to respondent)
    """

    __tablename__ = "wecode_eval_grading_tasks"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True,
        comment="Primary key ID",
    )
    answer_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Related answer ID",
    )
    question_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Related question ID",
    )
    question_version = Column(
        String(25),
        nullable=False,
        server_default="",
        comment="Question version for grading",
    )
    respondent_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        index=True,
        comment="Respondent user ID",
    )
    grader_id = Column(
        Integer, nullable=False, server_default="0", comment="Grader user ID"
    )
    team_id = Column(
        Integer,
        nullable=False,
        server_default="0",
        comment="Wegent Team ID for AI grading",
    )
    task_id = Column(
        Integer, nullable=False, server_default="0", comment="Wegent Task ID"
    )
    status = Column(
        Integer,
        nullable=False,
        server_default="0",
        comment="Status: 0=pending, 1=running, 2=completed, 3=failed, 4=published",
    )
    executor_id = Column(
        String(64),
        nullable=False,
        server_default="",
        comment="Executor instance ID for CAS protection",
    )
    attempt_count = Column(
        Integer,
        nullable=False,
        server_default="0",
        comment="Execution attempt count for retry logic",
    )
    error_message = Column(
        String(2000),
        nullable=False,
        server_default="",
        comment="Error message when failed",
    )
    report_data = Column(
        JSON, nullable=False, default=dict, comment="Grading report data"
    )
    report_s3_path = Column(
        String(500),
        nullable=False,
        server_default="",
        comment="Report S3 storage path",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        comment="Creation time",
    )
    started_at = Column(
        DateTime,
        nullable=False,
        server_default=text("'1970-01-01 00:00:00'"),
        comment="Grading start time",
    )
    completed_at = Column(
        DateTime,
        nullable=False,
        server_default=text("'1970-01-01 00:00:00'"),
        comment="Grading completion time",
    )
    published_at = Column(
        DateTime,
        nullable=False,
        server_default=text("'1970-01-01 00:00:00'"),
        comment="Report publication time",
    )

    __table_args__ = (
        Index("idx_wecode_eval_grading_tasks_answer", "answer_id"),
        Index("idx_wecode_eval_grading_tasks_question", "question_id"),
        Index("idx_wecode_eval_grading_tasks_respondent", "respondent_id"),
        Index("idx_wecode_eval_grading_tasks_status", "status"),
        Index("idx_wecode_eval_grading_tasks_task", "task_id"),
        Index("idx_wecode_eval_grading_tasks_grader", "grader_id"),
        {"mysql_charset": "utf8mb4"},
    )


# Constants for status values
class TopicStatus:
    """Topic status constants."""

    DRAFT = 0
    PUBLISHED = 1


class QuestionStatus:
    """Question status constants."""

    DRAFT = 0
    PUBLISHED = 1


class GradingTaskStatus:
    """Grading task status constants."""

    PENDING = 0
    RUNNING = 1
    COMPLETED = 2
    FAILED = 3
    PUBLISHED = 4


class TopicVisibility:
    """Topic visibility constants."""

    PUBLIC = "public"
    PRIVATE = "private"


class PermissionRole:
    """Permission role constants."""

    RESPONDENT = "respondent"
    GRADER = "grader"


class ContentType:
    """Content type constants."""

    TEXT = "text"
    URL = "url"
    ATTACHMENT = "attachment"
    MIXED = "mixed"
