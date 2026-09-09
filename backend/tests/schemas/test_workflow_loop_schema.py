# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validation rules for loop, branch, and start event nodes."""

import pytest
from pydantic import ValidationError

from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
    WorkflowNodeDefinition,
)


def _definition(nodes: list[dict]) -> ProjectWorkflowDefinition:
    return ProjectWorkflowDefinition(
        stage_mode="dag",
        advancement_policy="manual",
        nodes=[WorkflowNodeDefinition(**node) for node in nodes],
    )


def _loop_body() -> list[dict]:
    return [
        {
            "id": "ls",
            "name": "循环开始",
            "node_type": "loop_start",
            "loop_id": "loop1",
        },
        {
            "id": "br",
            "name": "分支",
            "node_type": "branch",
            "loop_id": "loop1",
            "depends_on": ["ls"],
            "branch_conditions": [
                {
                    "event_type": "change_request.checks_failed",
                    "handler_node_ids": ["fix1"],
                },
                {
                    "event_type": "change_request.merged",
                    "handler_node_ids": ["le"],
                },
            ],
        },
        {
            "id": "fix1",
            "name": "修复",
            "loop_id": "loop1",
            "depends_on": ["br"],
            "automation_rule_id": "r1",
            "execution_mode": "robot",
        },
        {
            "id": "le",
            "name": "循环结束",
            "node_type": "loop_end",
            "loop_id": "loop1",
            "depends_on": ["br"],
        },
    ]


def test_valid_loop_definition_parses():
    definition = _definition(
        [
            {
                "id": "start",
                "name": "触发",
                "node_type": "event",
                "role": "start",
            },
            {
                "id": "loop1",
                "name": "修复循环",
                "node_type": "loop",
                "depends_on": ["start"],
                "body_node_ids": ["ls", "br", "fix1", "le"],
                "loop_config": {"max_attempts": 5},
            },
            {
                "id": "after",
                "name": "发布",
                "depends_on": ["loop1"],
            },
            *_loop_body(),
        ]
    )
    assert len(definition.nodes) == 7
    loop = next(node for node in definition.nodes if node.node_type == "loop")
    assert loop.loop_config is not None and loop.loop_config.max_attempts == 5


def test_start_event_must_be_first_and_dependency_free():
    with pytest.raises(ValidationError, match="must be the first"):
        _definition(
            [
                {
                    "id": "a",
                    "name": "前置",
                },
                {
                    "id": "start",
                    "name": "触发",
                    "node_type": "event",
                    "role": "start",
                },
            ]
        )
    with pytest.raises(ValidationError, match="cannot depend"):
        _definition(
            [
                {
                    "id": "start",
                    "name": "触发",
                    "node_type": "event",
                    "role": "start",
                    "depends_on": ["a"],
                },
                {"id": "a", "name": "节点"},
            ]
        )


def test_loop_without_branch_is_valid():
    body = [
        {
            "id": "ls",
            "name": "循环开始",
            "node_type": "loop_start",
            "loop_id": "loop1",
        },
        {
            "id": "fix1",
            "name": "修复",
            "loop_id": "loop1",
            "depends_on": ["ls"],
            "automation_rule_id": "r1",
            "execution_mode": "robot",
        },
        {
            "id": "le",
            "name": "循环结束",
            "node_type": "loop_end",
            "loop_id": "loop1",
            "depends_on": ["fix1"],
        },
    ]
    definition = _definition(
        [
            {
                "id": "loop1",
                "name": "循环",
                "node_type": "loop",
                "body_node_ids": [node["id"] for node in body],
                "loop_config": {"max_attempts": 5},
            },
            *body,
        ]
    )
    loop = next(node for node in definition.nodes if node.node_type == "loop")
    assert loop.loop_config is not None


def test_loop_allows_multiple_branches():
    body = _loop_body()
    body.append(
        {
            "id": "br2",
            "name": "第二个分支",
            "node_type": "branch",
            "loop_id": "loop1",
            "depends_on": ["ls"],
            "branch_conditions": [
                {"event_type": "change_request.comment_created", "handler_node_ids": []}
            ],
        }
    )
    definition = _definition(
        [
            {
                "id": "loop1",
                "name": "循环",
                "node_type": "loop",
                "body_node_ids": [node["id"] for node in body],
            },
            *body,
        ]
    )
    branches = [node for node in definition.nodes if node.node_type == "branch"]
    assert len(branches) == 2


def test_body_node_cannot_depend_outside_loop():
    body = _loop_body()
    body[0]["depends_on"] = ["outside"]
    with pytest.raises(ValidationError, match="outside"):
        _definition(
            [
                {
                    "id": "loop1",
                    "name": "循环",
                    "node_type": "loop",
                    "body_node_ids": [node["id"] for node in body],
                },
                {"id": "outside", "name": "外部节点"},
                *body,
            ]
        )


def test_branch_handlers_cannot_be_shared():
    body = _loop_body()
    body[1]["branch_conditions"] = [
        {
            "event_type": "change_request.checks_failed",
            "handler_node_ids": ["fix1"],
        },
        {
            "event_type": "change_request.comment_created",
            "handler_node_ids": ["fix1"],
        },
    ]
    with pytest.raises(ValidationError, match="shared"):
        _definition(
            [
                {
                    "id": "loop1",
                    "name": "循环",
                    "node_type": "loop",
                    "body_node_ids": [node["id"] for node in body],
                },
                *body,
            ]
        )


def test_loop_cannot_be_nested():
    body = _loop_body()
    body.append(
        {
            "id": "inner",
            "name": "内层循环",
            "node_type": "loop",
            "loop_id": "loop1",
            "body_node_ids": [],
        }
    )
    with pytest.raises(ValidationError, match="nested"):
        _definition(
            [
                {
                    "id": "loop1",
                    "name": "循环",
                    "node_type": "loop",
                    "body_node_ids": [node["id"] for node in body],
                },
                *body,
            ]
        )


def test_legacy_definition_without_node_types_still_validates():
    definition = _definition(
        [
            {"id": "a", "name": "第一步"},
            {"id": "b", "name": "第二步", "depends_on": ["a"]},
        ]
    )
    assert all(node.node_type == "task" for node in definition.nodes)
