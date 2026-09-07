import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchTeamSelector } from './WorkbenchTeamSelector'

describe('WorkbenchTeamSelector', () => {
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

  test('labels the default path as cloud agent and lists cloud teams', () => {
    const onTeamChange = vi.fn()
    render(
      <WorkbenchTeamSelector
        teams={[
          {
            id: 7,
            name: 'review-team',
            displayName: '评审智能体',
            is_active: true,
          },
        ]}
        selectedTeamId={null}
        loading={false}
        onTeamChange={onTeamChange}
      />
    )

    expect(screen.getByTestId('workbench-team-selector')).toHaveTextContent('云端智能体')
    expect(screen.getByTestId('workbench-team-selector')).not.toHaveTextContent('Codex')

    fireEvent.click(screen.getByTestId('workbench-team-selector'))
    expect(screen.getByTestId('workbench-team-option-codex')).toHaveTextContent('Codex')
    expect(screen.getByTestId('workbench-team-option-7')).toHaveTextContent('评审智能体')

    fireEvent.click(screen.getByTestId('workbench-team-option-7'))
    expect(onTeamChange).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }))
  })

  test('shows the selected cloud team and can return to Codex', () => {
    const onTeamChange = vi.fn()
    render(
      <WorkbenchTeamSelector
        teams={[{ id: 7, name: 'review-team', displayName: '评审智能体', is_active: true }]}
        selectedTeamId={7}
        loading={false}
        onTeamChange={onTeamChange}
      />
    )

    expect(screen.getByTestId('workbench-team-selector')).toHaveTextContent('评审智能体')
    fireEvent.click(screen.getByTestId('workbench-team-selector'))
    fireEvent.click(screen.getByTestId('workbench-team-option-codex'))

    expect(onTeamChange).toHaveBeenCalledWith(null)
  })
})
