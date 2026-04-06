# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from knowledge_runtime.core.config import Settings
from pydantic import ValidationError


def test_settings_require_internal_service_token(monkeypatch) -> None:
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)

    with pytest.raises(ValidationError):
        Settings(_env_file=None)
