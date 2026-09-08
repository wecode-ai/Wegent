import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchRuntimeSelector } from './WorkbenchRuntimeSelector'

describe('WorkbenchRuntimeSelector', () => {
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

  test('selects Codex or an installed local runtime independently from the agent', () => {
    const onRuntimeChange = vi.fn()
    render(
      <WorkbenchRuntimeSelector
        runtime="codex"
        harnesses={[
          { id: 'claude_code', installed: true, executablePath: '/usr/bin/claude' },
          { id: 'opencode', installed: true, executablePath: '/usr/bin/opencode' },
        ]}
        enabledHarnesses={['claude_code', 'opencode']}
        loading={false}
        detectionFailed={false}
        onRuntimeChange={onRuntimeChange}
      />
    )

    fireEvent.click(screen.getByTestId('workbench-runtime-selector'))
    expect(screen.getByTestId('workbench-runtime-option-codex')).toHaveTextContent('Codex')
    expect(screen.getByTestId('workbench-runtime-option-claude_code')).toHaveTextContent(
      'Claude Code'
    )
    fireEvent.click(screen.getByTestId('workbench-runtime-option-claude_code'))
    expect(onRuntimeChange).toHaveBeenCalledWith('claude_code')
  })
})
