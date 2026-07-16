# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.models.blocks import BlockStatus, SubagentBlock, block_from_dict


def test_subagent_block_round_trip_preserves_parent_and_children():
    data = {
        "id": "Agent_1",
        "type": "subagent",
        "tool_use_id": "Agent_1",
        "tool_name": "Agent",
        "parent_tool_use_id": "Agent_0",
        "agent_type": "Explore",
        "summary": "Inspected backend",
        "status": "done",
        "children": [
            {
                "id": "child-text",
                "type": "text",
                "parent_tool_use_id": "Agent_1",
                "content": "Found parser path",
                "status": "done",
            }
        ],
    }

    block = block_from_dict(data)

    assert isinstance(block, SubagentBlock)
    assert block.to_dict() == {
        **data,
        "tool_input": {},
        "timestamp": 0,
    }


def test_subagent_block_defaults_to_queued():
    block = SubagentBlock(id="Agent_0", tool_use_id="Agent_0")

    assert block.status == BlockStatus.QUEUED.value
