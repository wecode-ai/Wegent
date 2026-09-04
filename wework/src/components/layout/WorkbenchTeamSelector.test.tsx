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

  test('keeps Codex as the default and selects a Wegent Team explicitly', () => {
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

    expect(screen.getByTestId('workbench-team-selector')).toHaveTextContent('Codex')
    fireEvent.click(screen.getByTestId('workbench-team-selector'))
    fireEvent.click(screen.getByTestId('workbench-team-option-7'))

    expect(onTeamChange).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }))
  })

  test('returns to the unchanged Codex path', () => {
    const onTeamChange = vi.fn()
    render(
      <WorkbenchTeamSelector
        teams={[{ id: 7, name: 'review-team', is_active: true }]}
        selectedTeamId={7}
        loading={false}
        onTeamChange={onTeamChange}
      />
    )

    fireEvent.click(screen.getByTestId('workbench-team-selector'))
    fireEvent.click(screen.getByTestId('workbench-team-option-codex'))

    expect(onTeamChange).toHaveBeenCalledWith(null)
  })
})
