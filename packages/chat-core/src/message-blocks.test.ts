// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { nestMessageBlocks, type MessageBlock } from './message-blocks'

describe('nestMessageBlocks', () => {
  it('rebuilds nested subagent tools from persisted flat blocks', () => {
    const blocks: MessageBlock[] = [
      {
        id: 'Agent_0',
        type: 'subagent',
        tool_use_id: 'Agent_0',
        title: 'Write essays',
        status: 'invoking',
        children: [],
      },
      {
        id: 'Write_1',
        type: 'tool',
        tool_use_id: 'Write_1',
        tool_name: 'Write',
        parent_tool_use_id: 'Agent_0',
        status: 'pending',
      },
      {
        id: 'Write_1',
        type: 'tool',
        tool_use_id: 'Write_1',
        tool_name: 'Write',
        parent_tool_use_id: 'Agent_0',
        tool_output: 'Saved',
        status: 'done',
      },
    ]

    expect(nestMessageBlocks(blocks)).toEqual([
      expect.objectContaining({
        id: 'Agent_0',
        children: [
          expect.objectContaining({
            id: 'Write_1',
            status: 'done',
            tool_output: 'Saved',
          }),
        ],
      }),
    ])
  })

  it('rebuilds recursive subagent trees regardless of flat block order', () => {
    const blocks: MessageBlock[] = [
      {
        id: 'Read_1',
        type: 'tool',
        tool_use_id: 'Read_1',
        tool_name: 'Read',
        parent_tool_use_id: 'Agent_1',
        status: 'done',
      },
      {
        id: 'Agent_1',
        type: 'subagent',
        tool_use_id: 'Agent_1',
        parent_tool_use_id: 'Agent_0',
        status: 'done',
      },
      {
        id: 'Agent_0',
        type: 'subagent',
        tool_use_id: 'Agent_0',
        status: 'done',
      },
    ]

    const nested = nestMessageBlocks(blocks)

    expect(nested).toHaveLength(1)
    expect(nested[0]).toMatchObject({
      id: 'Agent_0',
      children: [
        {
          id: 'Agent_1',
          children: [{ id: 'Read_1' }],
        },
      ],
    })
  })
})
