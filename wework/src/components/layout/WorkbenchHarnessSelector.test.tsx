import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchHarnessSelector } from './WorkbenchHarnessSelector'

describe('WorkbenchHarnessSelector', () => {
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

  test('combines Codex, Wegent Agents, and local harnesses in one selector', () => {
    const onRuntimeChange = vi.fn()
    const onTeamChange = vi.fn()
    render(
      <WorkbenchHarnessSelector
        runtime="codex"
        harnesses={[{ id: 'opencode', installed: true, executablePath: '/usr/bin/opencode' }]}
        enabledHarnesses={['opencode']}
        loading={false}
        detectionFailed={false}
        onRuntimeChange={onRuntimeChange}
        teams={[
          {
            id: 7,
            name: 'review-team',
            displayName: '评审智能体',
            is_active: true,
          },
        ]}
        selectedTeamId={null}
        teamsLoading={false}
        onTeamChange={onTeamChange}
      />
    )

    expect(screen.getByTestId('workbench-harness-selector')).toHaveTextContent('Codex')
    fireEvent.click(screen.getByTestId('workbench-harness-selector'))
    expect(screen.getByTestId('workbench-harness-option-codex')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-team-option-7')).toHaveTextContent('评审智能体')
    expect(screen.getByTestId('workbench-harness-option-opencode')).toHaveTextContent('OpenCode')

    fireEvent.click(screen.getByTestId('workbench-team-option-7'))

    expect(onRuntimeChange).toHaveBeenCalledWith('codex')
    expect(onTeamChange).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }))
  })

  test('shows the selected Wegent Agent instead of a second Codex label', () => {
    render(
      <WorkbenchHarnessSelector
        runtime="codex"
        harnesses={[]}
        enabledHarnesses={[]}
        loading={false}
        detectionFailed={false}
        onRuntimeChange={vi.fn()}
        teams={[{ id: 7, name: 'review-team', displayName: '评审智能体', is_active: true }]}
        selectedTeamId={7}
        onTeamChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('workbench-harness-selector')).toHaveTextContent('评审智能体')
    expect(screen.getByTestId('workbench-harness-selector')).not.toHaveTextContent('Codex')
  })

  test('clears the selected team when choosing a local harness', () => {
    const onRuntimeChange = vi.fn()
    const onTeamChange = vi.fn()
    render(
      <WorkbenchHarnessSelector
        runtime="codex"
        harnesses={[{ id: 'opencode', installed: true, executablePath: '/usr/bin/opencode' }]}
        enabledHarnesses={['opencode']}
        loading={false}
        detectionFailed={false}
        onRuntimeChange={onRuntimeChange}
        teams={[{ id: 7, name: 'review-team', is_active: true }]}
        selectedTeamId={7}
        onTeamChange={onTeamChange}
      />
    )

    fireEvent.click(screen.getByTestId('workbench-harness-selector'))
    fireEvent.click(screen.getByTestId('workbench-harness-option-opencode'))

    expect(onTeamChange).toHaveBeenCalledWith(null)
    expect(onRuntimeChange).toHaveBeenCalledWith('opencode')
  })

  test('returns from a Wegent Agent to the plain Codex path', () => {
    const onRuntimeChange = vi.fn()
    const onTeamChange = vi.fn()
    render(
      <WorkbenchHarnessSelector
        runtime="codex"
        harnesses={[]}
        enabledHarnesses={[]}
        loading={false}
        detectionFailed={false}
        onRuntimeChange={onRuntimeChange}
        teams={[{ id: 7, name: 'review-team', is_active: true }]}
        selectedTeamId={7}
        onTeamChange={onTeamChange}
      />
    )

    fireEvent.click(screen.getByTestId('workbench-harness-selector'))
    fireEvent.click(screen.getByTestId('workbench-harness-option-codex'))

    expect(onTeamChange).toHaveBeenCalledWith(null)
    expect(onRuntimeChange).toHaveBeenCalledWith('codex')
  })
})
