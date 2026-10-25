# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Notification keys prefer board labels and recognizable item identifiers."""

import pytest

from app.models.delivery import LoopItem
from app.services.notification_target import item_display_key


@pytest.mark.parametrize(
    ("name", "identifier", "expected"),
    [
        pytest.param("", "WEG-12", "WEG-12", id="alphabetic-prefix"),
        pytest.param("", "2026PRO-12", "2026PRO-12", id="digit-prefixed-key"),
        pytest.param("", "2026-12", "2026-12", id="numeric-prefix"),
        pytest.param("VISIBLE-4", "INTERNAL-9", "VISIBLE-4", id="explicit-name-wins"),
        pytest.param(
            None,
            "123e4567-e89b-12d3-a456-426614174000",
            None,
            id="opaque-uuid",
        ),
        pytest.param("", "3685496417598800322", None, id="internal-integer"),
        pytest.param(None, None, None, id="missing-key"),
    ],
)
def test_item_display_key(
    name: str | None, identifier: str | None, expected: str | None
) -> None:
    item = LoopItem(name=name, id=identifier)

    assert item_display_key(item) == expected
