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

  test('shows Codex and enabled local harnesses', () => {
    const onRuntimeChange = vi.fn()
    render(
      <WorkbenchHarnessSelector
        runtime="codex"
        harnesses={[{ id: 'opencode', installed: true, executablePath: '/usr/bin/opencode' }]}
        enabledHarnesses={['opencode']}
        loading={false}
        detectionFailed={false}
        onRuntimeChange={onRuntimeChange}
      />
    )

    expect(screen.getByTestId('workbench-harness-selector')).toHaveTextContent('Codex')
    fireEvent.click(screen.getByTestId('workbench-harness-selector'))
    expect(screen.getByTestId('workbench-harness-option-opencode')).toHaveTextContent('OpenCode')

    fireEvent.click(screen.getByTestId('workbench-harness-option-opencode'))
    expect(onRuntimeChange).toHaveBeenCalledWith('opencode')
  })
})
