import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchAgentSelector } from './WorkbenchAgentSelector'

describe('WorkbenchAgentSelector', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 48,
      height: 32,
      left: 120,
      right: 240,
      top: 16,
      width: 120,
      x: 120,
      y: 16,
      toJSON: () => ({}),
    })
  })

  test('selects one remote agent without rendering a Codex option', () => {
    const onTeamChange = vi.fn()
    render(
      <WorkbenchAgentSelector
        teams={[{ id: 7, name: 'review-team', displayName: '评审智能体', is_active: true }]}
        selectedTeamId={null}
        loading={false}
        onTeamChange={onTeamChange}
      />
    )

    fireEvent.click(screen.getByTestId('workbench-agent-selector'))
    expect(screen.getByTestId('workbench-agent-option-7')).toHaveTextContent('评审智能体')
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('workbench-agent-option-7'))
    expect(onTeamChange).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }))
  })

  test('shows the selected agent on the trigger', () => {
    render(
      <WorkbenchAgentSelector
        teams={[{ id: 7, name: 'review-team', displayName: '评审智能体', is_active: true }]}
        selectedTeamId={7}
        loading={false}
        onTeamChange={vi.fn()}
      />
    )
    expect(screen.getByTestId('workbench-agent-selector')).toHaveTextContent('评审智能体')
  })
})
