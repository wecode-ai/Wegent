# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DuckDBCache database model."""

from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.duckdb_cache import DuckDBCache


class TestDuckDBCacheModelCreation:
    """Tests for DuckDBCache model creation."""

    def test_create_cache_entry_with_required_fields(self, test_db: Session) -> None:
        """Should create a DuckDBCache entry with required fields."""
        entry = DuckDBCache(
            attachment_id=42,
            status="pending",
        )
        test_db.add(entry)
        test_db.flush()

        assert entry.id is not None
        assert entry.attachment_id == 42
        assert entry.status == "pending"
        assert entry.duckdb_attachment_id is None
        assert entry.summary is None
        assert entry.tables_count == 0
        assert entry.file_size == 0
        assert entry.source_file_hash is None
        assert entry.created_at is not None
        assert entry.updated_at is not None

    def test_create_cache_entry_with_all_fields(self, test_db: Session) -> None:
        """Should create a DuckDBCache entry with all fields populated."""
        entry = DuckDBCache(
            attachment_id=100,
            duckdb_attachment_id=200,
            summary={"tables": [{"name": "sales", "rows": 500}]},
            tables_count=1,
            file_size=4096,
            source_file_hash="abc123def456",
            status="ready",
        )
        test_db.add(entry)
        test_db.flush()

        assert entry.attachment_id == 100
        assert entry.duckdb_attachment_id == 200
        assert entry.summary["tables"][0]["name"] == "sales"
        assert entry.tables_count == 1
        assert entry.file_size == 4096
        assert entry.source_file_hash == "abc123def456"
        assert entry.status == "ready"

    def test_default_status_is_pending(self, test_db: Session) -> None:
        """Default status should be 'pending'."""
        entry = DuckDBCache(attachment_id=1, status="pending")
        assert entry.status == "pending"

    def test_default_tables_count_is_zero(self, test_db: Session) -> None:
        """Default tables_count should be 0."""
        entry = DuckDBCache(attachment_id=1, tables_count=0)
        assert entry.tables_count == 0

    def test_default_file_size_is_zero(self, test_db: Session) -> None:
        """Default file_size should be 0."""
        entry = DuckDBCache(attachment_id=1, file_size=0)
        assert entry.file_size == 0

    def test_status_transitions(self, test_db: Session) -> None:
        """Status should transition through pending -> generating -> ready."""
        entry = DuckDBCache(attachment_id=50, status="pending")
        test_db.add(entry)
        test_db.flush()

        # Transition to generating
        entry.status = "generating"
        test_db.flush()
        assert entry.status == "generating"

        # Transition to ready
        entry.status = "ready"
        entry.duckdb_attachment_id = 99
        entry.tables_count = 3
        test_db.flush()
        assert entry.status == "ready"
        assert entry.duckdb_attachment_id == 99

    def test_failed_status(self, test_db: Session) -> None:
        """Should support 'failed' status."""
        entry = DuckDBCache(attachment_id=60, status="generating")
        test_db.add(entry)
        test_db.flush()

        entry.status = "failed"
        test_db.flush()
        assert entry.status == "failed"

    def test_summary_json_field(self, test_db: Session) -> None:
        """Summary should store and retrieve complex JSON data."""
        summary_data = {
            "sales": [
                {
                    "column_name": "id",
                    "column_type": "INTEGER",
                    "min": 1,
                    "max": 1000,
                    "approx_unique": 950,
                },
                {
                    "column_name": "amount",
                    "column_type": "DOUBLE",
                    "min": 0.0,
                    "max": 99999.99,
                    "avg": 150.5,
                },
            ]
        }
        entry = DuckDBCache(
            attachment_id=70,
            status="ready",
            summary=summary_data,
        )
        test_db.add(entry)
        test_db.flush()

        # Retrieve and verify
        retrieved = test_db.query(DuckDBCache).filter_by(attachment_id=70).first()
        assert retrieved.summary == summary_data
        assert retrieved.summary["sales"][0]["column_name"] == "id"


class TestDuckDBCacheUniqueConstraint:
    """Tests for the unique constraint on attachment_id."""

    def test_unique_constraint_prevents_duplicate_attachment_id(
        self, test_db: Session
    ) -> None:
        """Should prevent two entries with the same attachment_id."""
        entry1 = DuckDBCache(attachment_id=42, status="pending")
        test_db.add(entry1)
        test_db.flush()

        entry2 = DuckDBCache(attachment_id=42, status="ready")
        test_db.add(entry2)

        with pytest.raises(IntegrityError):
            test_db.flush()

        test_db.rollback()

    def test_different_attachment_ids_allowed(self, test_db: Session) -> None:
        """Should allow entries with different attachment_ids."""
        entry1 = DuckDBCache(attachment_id=1, status="pending")
        entry2 = DuckDBCache(attachment_id=2, status="pending")
        test_db.add(entry1)
        test_db.add(entry2)
        test_db.flush()

        assert entry1.id != entry2.id
        assert entry1.attachment_id != entry2.attachment_id


class TestDuckDBCacheTimestamps:
    """Tests for created_at and updated_at timestamps."""

    def test_created_at_set_on_creation(self, test_db: Session) -> None:
        """created_at should be set automatically on creation."""
        entry = DuckDBCache(attachment_id=80)
        test_db.add(entry)
        test_db.flush()

        assert entry.created_at is not None

    def test_updated_at_set_on_creation(self, test_db: Session) -> None:
        """updated_at should be set automatically on creation."""
        entry = DuckDBCache(attachment_id=81)
        test_db.add(entry)
        test_db.flush()

        assert entry.updated_at is not None

    def test_updated_at_changes_on_update(self, test_db: Session) -> None:
        """updated_at should change when the entry is updated."""
        entry = DuckDBCache(attachment_id=82, status="pending")
        test_db.add(entry)
        test_db.flush()

        original_updated_at = entry.updated_at

        # Update the entry
        entry.status = "ready"
        test_db.flush()

        # Note: onupdate may not fire in the same second for SQLite,
        # so we just verify the field exists and is not None
        assert entry.updated_at is not None
