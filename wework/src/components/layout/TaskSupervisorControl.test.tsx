import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SupervisorSuggestionCards, TaskSupervisorControl } from './TaskSupervisorControl'
import type { RuntimeSupervisorState } from '@/types/api'

const supervisor: RuntimeSupervisorState = {
  mode: 'suggest',
  status: 'active',
  instructions: 'Keep the task focused',
  suggestions: [
    {
      id: 'suggestion-1',
      message: 'Return to the requested scope.',
      rationale: 'The current changes are unrelated.',
      status: 'pending',
      createdAt: 1,
    },
  ],
}

describe('TaskSupervisorControl', () => {
  test('configures a disabled task supervisor independently', async () => {
    const onSet = vi.fn().mockResolvedValue(supervisor)

    render(<TaskSupervisorControl supervisor={null} onSet={onSet} onClear={vi.fn()} />)

    fireEvent.click(screen.getByTestId('task-supervisor-toggle-button'))
    expect(screen.queryByTestId('task-supervisor-mode-observe')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-supervisor-mode-auto'))
    fireEvent.change(screen.getByTestId('task-supervisor-instructions'), {
      target: { value: 'Stop destructive operations' },
    })
    fireEvent.click(screen.getByTestId('task-supervisor-save-button'))

    await waitFor(() =>
      expect(onSet).toHaveBeenCalledWith('auto', 'Stop destructive operations', null, 30)
    )
  })

  test('selects an independent review model and frequency', async () => {
    const onSet = vi.fn().mockResolvedValue(supervisor)
    render(
      <TaskSupervisorControl
        supervisor={null}
        models={[{ name: 'gpt-5.6-luna', type: 'codex', displayName: 'GPT 5.6 Luna' }]}
        onSet={onSet}
        onClear={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('task-supervisor-toggle-button'))
    fireEvent.change(screen.getByTestId('task-supervisor-model'), {
      target: { value: 'gpt-5.6-luna' },
    })
    fireEvent.change(screen.getByTestId('task-supervisor-frequency'), {
      target: { value: '60' },
    })
    fireEvent.click(screen.getByTestId('task-supervisor-save-button'))

    await waitFor(() => expect(onSet).toHaveBeenCalledWith('suggest', '', 'gpt-5.6-luna', 60))
  })

  test('opens the configuration panel above the trigger', () => {
    render(<TaskSupervisorControl supervisor={null} onSet={vi.fn()} onClear={vi.fn()} />)

    fireEvent.click(screen.getByTestId('task-supervisor-toggle-button'))

    expect(screen.getByTestId('task-supervisor-panel')).toHaveClass(
      'bottom-[calc(100%+0.5rem)]',
      'max-h-[calc(100vh-8rem)]',
      'overflow-y-auto'
    )
  })

  test('distinguishes an active supervisor from an in-progress check', () => {
    const { rerender } = render(
      <TaskSupervisorControl supervisor={supervisor} onSet={vi.fn()} onClear={vi.fn()} />
    )

    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
      'workbench.supervisor_active'
    )

    rerender(
      <TaskSupervisorControl
        supervisor={{ ...supervisor, status: 'checking' }}
        onSet={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
      'workbench.supervisor_checking'
    )
  })

  test('shows when the latest check found no correction', () => {
    render(
      <TaskSupervisorControl
        supervisor={{ ...supervisor, lastEvaluatedAt: 100, suggestions: [] }}
        onSet={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
      'workbench.supervisor_aligned'
    )
  })

  test('renders pending suggestions and resolves explicit actions', async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined)
    const onDismiss = vi.fn().mockResolvedValue(undefined)

    render(
      <SupervisorSuggestionCards
        suggestions={supervisor.suggestions}
        onAccept={onAccept}
        onDismiss={onDismiss}
      />
    )

    expect(screen.getByText('Return to the requested scope.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-supervisor-accept-suggestion'))
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith(supervisor.suggestions[0]))
  })
})
