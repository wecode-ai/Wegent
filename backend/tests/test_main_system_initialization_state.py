# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from app.core.config import settings
from app.services.admin_password_bootstrap import (
    get_cached_admin_password_setup_required,
    reset_admin_password_setup_state_cache,
    set_admin_password_setup_required_cache,
)


def test_startup_skips_system_initialization_state_load_when_disabled(monkeypatch):
    import app.main as main

    monkeypatch.setattr(settings, "CHECK_SYSTEM_INITIALIZATION_STATUS", False)
    set_admin_password_setup_required_cache(True)

    def fail_session_local():
        raise AssertionError(
            "startup should not open a DB session when check is disabled"
        )

    monkeypatch.setattr(main, "SessionLocal", fail_session_local)

    main._load_system_initialization_state(logging.getLogger(__name__))

    monkeypatch.setattr(settings, "CHECK_SYSTEM_INITIALIZATION_STATUS", True)
    assert get_cached_admin_password_setup_required() is False


def teardown_function():
    settings.CHECK_SYSTEM_INITIALIZATION_STATUS = True
    reset_admin_password_setup_state_cache()
