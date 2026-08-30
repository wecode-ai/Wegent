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
  test('keeps the prompt title independent from terminal title changes', () => {
    render(
      <CentralHarnessTerminal
        sessionId="local-harness-1"
        title="Initial prompt"
        cwd="/workspace/project"
        active
        onExit={vi.fn()}
      />
    )

    expect(screen.getByText('Initial prompt')).toBeInTheDocument()
    expect(embeddedTerminalProps.current.onTitleChange).toBeUndefined()
  })
})
