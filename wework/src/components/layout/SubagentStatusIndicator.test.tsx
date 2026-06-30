import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { SubagentStatusIndicator } from './SubagentStatusIndicator'
import type { RuntimeSubagentStatus } from '@/types/workbench'

const statuses: RuntimeSubagentStatus[] = [
  {
    id: '019f17ae-8295-7072-84e0-94ca0ffa96e5',
    agentId: '019f17ae-8295-7072-84e0-94ca0ffa96e5',
    agentPath: 'thread:019f17ae-8295-7072-84e0-94ca0ffa96e5',
    agentName: 'worker',
    status: 'running',
    updatedAtMs: 12345,
  },
]

describe('SubagentStatusIndicator', () => {
  test('expands automatically when title space is available', () => {
    render(<SubagentStatusIndicator statuses={statuses} availableWidth={900} />)

    expect(screen.getByTestId('subagent-status-panel')).toBeInTheDocument()
    expect(screen.getByText('worker')).toBeInTheDocument()
    expect(screen.getByText('0ffa96e5')).toBeInTheDocument()
  })

  test('collapses when title space is constrained and opens on hover', () => {
    render(<SubagentStatusIndicator statuses={statuses} availableWidth={360} />)

    expect(screen.queryByTestId('subagent-status-panel')).not.toBeInTheDocument()

    fireEvent.mouseEnter(screen.getByTestId('subagent-status-hover-region'))

    expect(screen.getByTestId('subagent-status-panel')).toBeInTheDocument()

    fireEvent.mouseLeave(screen.getByTestId('subagent-status-hover-region'))

    expect(screen.queryByTestId('subagent-status-panel')).not.toBeInTheDocument()
  })
})
