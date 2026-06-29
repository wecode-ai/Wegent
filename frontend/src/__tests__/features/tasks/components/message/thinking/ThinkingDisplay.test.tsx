// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import ThinkingDisplay from '@/features/tasks/components/message/thinking/ThinkingDisplay'

jest.mock('@/features/tasks/components/message/thinking/ToolBlocksView', () => ({
  __esModule: true,
  default: () => <div data-testid="tool-blocks-view" />,
}))

jest.mock('@/features/tasks/components/message/thinking/DetailedThinkingView', () => ({
  __esModule: true,
  default: () => <div data-testid="detailed-thinking-view" />,
}))

describe('ThinkingDisplay', () => {
  it('uses ChatShell-style tool blocks for ClaudeCode thinking steps', () => {
    render(
      <ThinkingDisplay
        shellType="ClaudeCode"
        taskStatus="RUNNING"
        thinking={[
          {
            title: 'Executing command',
            next_action: 'continue',
            details: {
              type: 'tool_use',
              status: 'started',
              tool_name: 'Bash',
              input: { command: 'pwd' },
            },
          },
        ]}
      />
    )

    expect(screen.getByTestId('tool-blocks-view')).toBeInTheDocument()
    expect(screen.queryByTestId('detailed-thinking-view')).not.toBeInTheDocument()
  })

  it('keeps text-type thinking steps on the detailed renderer', () => {
    render(
      <ThinkingDisplay
        shellType="Chat"
        taskStatus="RUNNING"
        thinking={[
          {
            title: 'Researching',
            next_action: 'continue',
            details: {
              type: 'text',
            },
          },
        ]}
      />
    )

    expect(screen.getByTestId('detailed-thinking-view')).toBeInTheDocument()
    expect(screen.queryByTestId('tool-blocks-view')).not.toBeInTheDocument()
  })
})
