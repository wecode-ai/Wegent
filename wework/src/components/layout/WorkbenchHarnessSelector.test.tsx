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

  test('combines cloud agents and local coding tools in one selector', () => {
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

    expect(screen.getAllByTestId('workbench-harness-selector')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('workbench-harness-selector'))

    expect(screen.getByTestId('workbench-cloud-agent-heading')).toHaveTextContent('云端智能体')
    expect(screen.getByTestId('workbench-team-option-7')).toHaveTextContent('评审智能体')
    expect(screen.getByTestId('workbench-local-harness-heading')).toHaveTextContent('本地编码工具')
    expect(screen.getByTestId('workbench-harness-option-opencode')).toHaveTextContent('OpenCode')

    fireEvent.click(screen.getByTestId('workbench-team-option-7'))
    expect(onRuntimeChange).toHaveBeenCalledWith('codex')
    expect(onTeamChange).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }))
  })

  test('keeps the cloud-agent section visible while disconnected', () => {
    render(
      <WorkbenchHarnessSelector
        runtime="codex"
        harnesses={[]}
        enabledHarnesses={[]}
        loading={false}
        detectionFailed={false}
        onRuntimeChange={vi.fn()}
        teams={[]}
        selectedTeamId={null}
        teamsLoading={false}
        onTeamChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('workbench-harness-selector'))
    expect(screen.getByTestId('workbench-cloud-agent-heading')).toHaveTextContent('云端智能体')
    expect(screen.getByTestId('workbench-cloud-agent-empty')).toHaveTextContent(
      '连接云端后显示可用智能体'
    )
  })

  test('shows the selected cloud agent on the single trigger', () => {
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
        teamsLoading={false}
        onTeamChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('workbench-harness-selector')).toHaveTextContent('评审智能体')
    expect(screen.getByTestId('workbench-harness-selector')).not.toHaveTextContent('Codex')
  })

  test('clears the selected cloud agent when choosing a local coding tool', () => {
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
        teamsLoading={false}
        onTeamChange={onTeamChange}
      />
    )

    fireEvent.click(screen.getByTestId('workbench-harness-selector'))
    fireEvent.click(screen.getByTestId('workbench-harness-option-opencode'))

    expect(onTeamChange).toHaveBeenCalledWith(null)
    expect(onRuntimeChange).toHaveBeenCalledWith('opencode')
  })
})
