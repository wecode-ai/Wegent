// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { ToolBlock } from '@/features/tasks/components/message/thinking/components/ToolBlock'
import type { ToolPair } from '@/features/tasks/components/message/thinking/types'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
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
})
