import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { CentralHarnessTerminal } from './CentralHarnessTerminal'

const embeddedTerminalProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('./workspace-panels/EmbeddedLocalTerminal', () => ({
  EmbeddedLocalTerminal: (props: Record<string, unknown>) => {
    embeddedTerminalProps.current = props
    return <div data-testid="mock-embedded-local-terminal" />
  },
}))

describe('CentralHarnessTerminal', () => {
  test('forwards Harness-generated terminal titles to the workbench', () => {
    const onTitleChange = vi.fn()

    render(
      <CentralHarnessTerminal
        sessionId="local-harness-1"
        harnessId="opencode"
        title="Initial prompt"
        cwd="/workspace/project"
        active
        onTitleChange={onTitleChange}
        onExit={vi.fn()}
      />
    )

    expect(screen.getByText('Initial prompt')).toBeInTheDocument()
    const forwarded = embeddedTerminalProps.current.onTitleChange as (title: string) => void
    forwarded('Generated title')
    expect(onTitleChange).toHaveBeenCalledWith('Generated title')
  })

  test('ignores the generic Harness application title', () => {
    const onTitleChange = vi.fn()

    render(
      <CentralHarnessTerminal
        sessionId="local-harness-1"
        harnessId="opencode"
        title="Inspect available plugins"
        cwd="/workspace/project"
        active
        onTitleChange={onTitleChange}
        onExit={vi.fn()}
      />
    )

    const forwarded = embeddedTerminalProps.current.onTitleChange as (title: string) => void
    forwarded('OpenCode')
    expect(onTitleChange).not.toHaveBeenCalled()
  })
})
