# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest

from app.services.task_skill_selection import (
    build_task_skill_labels,
    parse_requested_skill_refs_from_labels,
)


@pytest.mark.parametrize("skill_id", [0, -1, "invalid", True, 1.5, None])
def test_invalid_optional_skill_id_is_omitted_from_persisted_refs(skill_id):
    labels = build_task_skill_labels([{"name": "pdf", "skill_id": skill_id}])
    refs = parse_requested_skill_refs_from_labels(labels)
    assert refs == [{"name": "pdf", "namespace": "default", "is_public": False}]


def test_positive_skill_id_survives_label_round_trip():
    labels = build_task_skill_labels([{"name": "pdf", "skill_id": 42}])
    assert parse_requested_skill_refs_from_labels(labels)[0]["skill_id"] == 42


def test_build_task_skill_labels_persists_requested_refs_and_names():
    labels = build_task_skill_labels(
        [
            {"name": "android-source-setup", "namespace": "mobile", "is_public": False},
            {"name": "pdf", "namespace": "default", "is_public": True},
        ]
    )

    assert json.loads(labels["additionalSkills"]) == [
        "android-source-setup",
        "pdf",
    ]
    assert json.loads(labels["requestedSkillRefs"]) == [
        {
            "name": "android-source-setup",
            "namespace": "mobile",
            "is_public": False,
        },
        {
            "name": "pdf",
            "namespace": "default",
            "is_public": True,
        },
    ]


def test_parse_requested_skill_refs_from_labels_returns_normalized_refs():
    parsed = parse_requested_skill_refs_from_labels(
        {
            "requestedSkillRefs": json.dumps(
                [
                    {
                        "name": "android-source-setup",
                        "namespace": "mobile",
                        "is_public": False,
                    }
                ]
            )
        }
    )

    assert parsed == [
        {
            "name": "android-source-setup",
            "namespace": "mobile",
            "is_public": False,
        }
    ]


def test_build_task_skill_labels_deduplicates_by_name_with_last_value_winning():
    labels = build_task_skill_labels(
        [
            {
                "name": "android-source-setup",
                "namespace": "mobile-a",
                "is_public": False,
            },
            {"name": "pdf", "namespace": "default", "is_public": True},
            {
                "name": "android-source-setup",
                "namespace": "mobile-b",
                "is_public": False,
            },
        ]
    )

    assert json.loads(labels["additionalSkills"]) == ["pdf", "android-source-setup"]
    assert json.loads(labels["requestedSkillRefs"]) == [
        {
            "name": "pdf",
            "namespace": "default",
            "is_public": True,
        },
        {
            "name": "android-source-setup",
            "namespace": "mobile-b",
            "is_public": False,
        },
    ]
