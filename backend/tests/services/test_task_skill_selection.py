# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

from app.services.task_skill_selection import (
    build_task_skill_labels,
    parse_requested_skill_refs_from_labels,
)


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
