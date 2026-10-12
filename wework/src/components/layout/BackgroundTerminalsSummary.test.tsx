import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { BackgroundTerminalsSummary } from './BackgroundTerminalsSummary'
import type { BackgroundTerminal } from './backgroundTerminals'
import '@/i18n'

const terminal: BackgroundTerminal = {
  id: 'command-1',
  tabId: 'background-terminal:task-1:command-1',
  command: 'pnpm dev',
  cwd: '/project',
  running: true,
  background: true,
  block: {
    id: 'command-1',
    subtaskId: 'turn-1',
    type: 'tool',
    toolName: 'bash',
    status: 'streaming',
    createdAt: 1,
  },
}

describe('BackgroundTerminalsSummary', () => {
  test.each([
    ['/opt/homebrew/bin/zsh -lc "pnpm dev"', 'pnpm dev'],
    [String.raw`/bin/zsh -lc '/bin/bash -lc "npm run server"'`, 'npm run server'],
    ['pnpm dev', 'pnpm dev'],
  ])('shows the actual command and preserves the original launcher %s', (command, label) => {
    const onOpen = vi.fn()
    const entry = { ...terminal, command }
    render(<BackgroundTerminalsSummary terminals={[entry]} onOpen={onOpen} />)
    const button = screen.getByTestId('open-background-terminal-command-1')
    expect(button).toHaveTextContent(label)
    expect(button).not.toHaveTextContent(' -lc ')
    expect(button).toHaveAttribute('title', command)
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledWith(entry)
  })

  test('opens the selected terminal and prevents duplicate stop requests while pending', async () => {
    let finish!: () => void
    const onStop = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const onOpen = vi.fn()
    render(<BackgroundTerminalsSummary terminals={[terminal]} onOpen={onOpen} onStop={onStop} />)
    expect(screen.getByTestId('environment-background-terminals-section')).toHaveTextContent(
      '后台进程1'
    )
    fireEvent.click(screen.getByText('pnpm dev'))
    expect(onOpen).toHaveBeenCalledWith(terminal)
    const stop = screen.getByRole('button', { name: '停止全部后台终端' })
    fireEvent.click(stop)
    expect(stop).toBeDisabled()
    fireEvent.click(stop)
    expect(onStop).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(stop).toBeEnabled())
  })

  test('keeps processes visible and allows recovery after a stop failure', async () => {
    const onStop = vi.fn().mockRejectedValue(new Error('Disconnected'))
    render(<BackgroundTerminalsSummary terminals={[terminal]} onOpen={vi.fn()} onStop={onStop} />)
    fireEvent.click(screen.getByRole('button', { name: '停止全部后台终端' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法停止后台终端')
    expect(screen.getByText('pnpm dev')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止全部后台终端' })).toBeEnabled()
  })

  test('hides the section when empty and omits unsupported stop actions', () => {
    const { rerender } = render(<BackgroundTerminalsSummary terminals={[]} onOpen={vi.fn()} />)
    expect(screen.queryByTestId('environment-background-terminals-section')).toBeNull()
    rerender(<BackgroundTerminalsSummary terminals={[terminal]} onOpen={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '停止全部后台终端' })).toBeNull()
  })
})
