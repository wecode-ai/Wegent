# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for database session management."""

import pytest

from knowledge_runtime.db.session import get_db, init_db, is_db_initialized


def test_init_db_creates_session_factory():
    """init_db should create a session factory."""
    init_db("sqlite:///:memory:")
    assert is_db_initialized()


def test_get_db_yields_session():
    """get_db should yield a usable SQLAlchemy Session."""
    init_db("sqlite:///:memory:")
    session_gen = get_db()
    session = next(session_gen)
    assert session is not None
    # Clean up the generator
    try:
        next(session_gen)
    except StopIteration:
        pass


def test_get_db_raises_when_not_initialized():
    """get_db should raise RuntimeError if DB not initialized."""
    import knowledge_runtime.db.session as session_mod

    session_mod._session_factory = None
    with pytest.raises(RuntimeError, match="Database not initialized"):
        next(get_db())
