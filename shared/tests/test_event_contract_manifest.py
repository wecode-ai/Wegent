# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

from shared.event_reporting.contracts import ADV_GROUPS, EVENT_TYPES, FIELDS
from shared.event_reporting.envelope import ALLOWED_STATUSES


def test_language_neutral_manifest_matches_python_contract() -> None:
    manifest_path = (
        Path(__file__).parents[1]
        / "event_reporting"
        / "schema"
        / "knowledge_events_v1.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert manifest["schema_version"] == 1
    assert set(manifest["event_types"]) == EVENT_TYPES
    assert set(manifest["fields"]) == FIELDS
    assert set(manifest["statuses"]) == ALLOWED_STATUSES
    assert {
        event_type: f"adv_{group}_enabled"
        for event_type, group in manifest["adv_groups"].items()
    } == ADV_GROUPS
    assert manifest["event_max_bytes"] == 8 * 1024
    assert manifest["max_string_characters"] == 256
    assert manifest["max_data_fields"] == 48
    assert manifest["max_fact_key_parts"] == 64
    assert manifest["max_id_list_items"] == 64
