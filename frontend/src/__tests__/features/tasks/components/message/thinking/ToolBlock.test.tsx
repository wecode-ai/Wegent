// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { ToolBlock } from '@/features/tasks/components/message/thinking/components/ToolBlock'
import type { ToolPair } from '@/features/tasks/components/message/thinking/types'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'thinking.no_output': 'No output',
      })[key] ?? key,
  }),
}))

jest.mock('@/components/common/EnhancedMarkdown', () => ({
  __esModule: true,
  default: ({ source }: { source: string }) => <div>{source}</div>,
}))

function createTool(input: string | Record<string, unknown>): ToolPair {
  return {
    toolUseId: 'tool_write',
    toolName: 'Write',
    status: 'done',
    toolUse: {
      title: 'Using Write',
      next_action: 'continue',
      tool_use_id: 'tool_write',
      details: {
        type: 'tool_use',
        tool_name: 'Write',
        status: 'started',
        input,
      },
    },
  }
}

describe('ToolBlock', () => {
  it('does not show empty stringified input in the compact label', () => {
    render(<ToolBlock tool={createTool('{}')} />)

    expect(screen.queryByText(/\{\}/)).not.toBeInTheDocument()
  })

  it('does not show empty object input in the compact label', () => {
    render(<ToolBlock tool={createTool({})} />)

    expect(screen.queryByText(/\{\}/)).not.toBeInTheDocument()
  })

  it('does not expose missing translation keys for completed tools without output', () => {
    const emptyTool = createTool({})
    render(
      <ToolBlock
        tool={emptyTool}
        defaultExpanded
        count={2}
        mergedTools={[emptyTool, { ...emptyTool, toolUseId: 'tool_write_2' }]}
      />
    )

    expect(screen.queryByText('thinking.no_output')).not.toBeInTheDocument()
    expect(screen.getAllByText('No output')).toHaveLength(2)
  })
})
