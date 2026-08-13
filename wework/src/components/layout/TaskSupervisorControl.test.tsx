import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import {
  SupervisorSuggestionCards,
  TaskSupervisorControl,
  TaskSupervisorStatusButton,
} from './TaskSupervisorControl'
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

    render(
      <TaskSupervisorControl
        open
        supervisor={null}
        models={[
          {
            name: 'review-model',
            type: 'public',
            namespace: 'default',
            resourceUserId: 0,
          },
        ]}
        onOpenChange={vi.fn()}
        onSet={onSet}
        onClear={vi.fn()}
      />
    )

    expect(screen.queryByTestId('task-supervisor-mode-observe')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-supervisor-mode-auto')).toHaveClass('bg-text-primary')
    fireEvent.change(screen.getByTestId('task-supervisor-instructions'), {
      target: { value: 'Stop destructive operations' },
    })
    fireEvent.click(screen.getByTestId('task-supervisor-save-button'))

    await waitFor(() =>
      expect(onSet).toHaveBeenCalledWith(
        'auto',
        'Stop destructive operations',
        {
          modelName: 'review-model',
          modelType: 'public',
          options: {
            weworkCloudModelNamespace: 'default',
            weworkCloudModelResourceUserId: '0',
          },
        },
        30
      )
    )
  })

  test('selects an independent review model and frequency', async () => {
    const onSet = vi.fn().mockResolvedValue(supervisor)
    render(
      <TaskSupervisorControl
        supervisor={null}
        open
        onOpenChange={vi.fn()}
        models={[
          {
            name: 'gpt-5.6-luna',
            type: 'public',
            displayName: 'GPT 5.6 Luna',
            namespace: 'default',
            resourceUserId: 0,
            compatibilityDisabled: true,
            compatibilityDisabledReason: 'runtime_family_mismatch',
          },
        ]}
        onSet={onSet}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByTestId('task-supervisor-model')).toHaveTextContent('GPT 5.6 Luna')
    fireEvent.change(screen.getByTestId('task-supervisor-model'), {
      target: { value: 'public:gpt-5.6-luna' },
    })
    fireEvent.change(screen.getByTestId('task-supervisor-frequency'), {
      target: { value: '60' },
    })
    fireEvent.click(screen.getByTestId('task-supervisor-save-button'))

    await waitFor(() =>
      expect(onSet).toHaveBeenCalledWith(
        'auto',
        '',
        {
          modelName: 'gpt-5.6-luna',
          modelType: 'public',
          options: {
            weworkCloudModelNamespace: 'default',
            weworkCloudModelResourceUserId: '0',
          },
        },
        60
      )
    )
  })

  test('reopens supervision configured before the task starts', () => {
    render(
      <TaskSupervisorControl
        open
        supervisor={null}
        initialConfig={{
          mode: 'auto',
          instructions: 'Review from the first turn',
          modelSelection: {
            modelName: 'gpt-5.6-luna',
            modelType: 'public',
            options: {
              weworkCloudModelNamespace: 'default',
              weworkCloudModelResourceUserId: '0',
            },
          },
          intervalSeconds: 60,
        }}
        models={[
          {
            name: 'gpt-5.6-luna',
            type: 'public',
            displayName: 'GPT 5.6 Luna',
            namespace: 'default',
            resourceUserId: 0,
          },
        ]}
        onOpenChange={vi.fn()}
        onSet={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-supervisor-mode-auto')).toHaveClass('bg-text-primary')
    expect(screen.getByTestId('task-supervisor-instructions')).toHaveValue(
      'Review from the first turn'
    )
    expect(screen.getByTestId('task-supervisor-model')).toHaveValue('public:gpt-5.6-luna')
    expect(screen.getByTestId('task-supervisor-frequency')).toHaveValue('60')
    expect(screen.getByTestId('task-supervisor-disable-button')).toBeInTheDocument()
  })

  test('keeps an incompatible cloud model selected when supervision reopens', () => {
    render(
      <TaskSupervisorControl
        open
        supervisor={{
          ...supervisor,
          modelSelection: {
            modelName: 'review-model',
            modelType: 'public',
            options: {
              weworkCloudModelNamespace: 'default',
              weworkCloudModelResourceUserId: '0',
            },
          },
        }}
        models={[
          {
            name: 'review-model',
            type: 'public',
            displayName: 'Review Model',
            namespace: 'default',
            resourceUserId: 0,
            compatibilityDisabled: true,
            compatibilityDisabledReason: 'runtime_family_mismatch',
          },
        ]}
        onOpenChange={vi.fn()}
        onSet={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-supervisor-model')).toHaveValue('public:review-model')
  })

  test('renders configuration in an accessible dialog', () => {
    render(
      <TaskSupervisorControl
        open
        supervisor={null}
        onOpenChange={vi.fn()}
        onSet={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByRole('dialog')).toContainElement(screen.getByTestId('task-supervisor-panel'))
  })

  test('distinguishes an active supervisor from an in-progress check', () => {
    const { rerender } = render(
      <TaskSupervisorStatusButton supervisor={supervisor} onClick={vi.fn()} />
    )

    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
      'workbench.supervisor_active'
    )

    rerender(
      <TaskSupervisorStatusButton
        supervisor={{ ...supervisor, status: 'checking' }}
        onClick={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
      'workbench.supervisor_checking'
    )
  })

  test('shows when the latest check found no correction', () => {
    render(
      <TaskSupervisorStatusButton
        supervisor={{ ...supervisor, lastEvaluatedAt: 100, suggestions: [] }}
        onClick={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
      'workbench.supervisor_aligned'
    )
  })

  test('shows the next scheduled check and can run immediately', async () => {
    const onRunNow = vi.fn().mockResolvedValue(supervisor)

    render(
      <TaskSupervisorControl
        open
        supervisor={{
          ...supervisor,
          intervalSeconds: 30,
          lastEvaluatedAt: Date.now(),
        }}
        onOpenChange={vi.fn()}
        onSet={vi.fn()}
        onClear={vi.fn()}
        onRunNow={onRunNow}
      />
    )

    expect(screen.getByTestId('task-supervisor-next-check')).toHaveTextContent(
      'workbench.supervisor_next_check'
    )
    fireEvent.click(screen.getByTestId('task-supervisor-run-now-button'))

    await waitFor(() => expect(onRunNow).toHaveBeenCalledTimes(1))
  })

  test('disables immediate review while a check is running', () => {
    render(
      <TaskSupervisorControl
        open
        supervisor={{ ...supervisor, status: 'checking' }}
        onOpenChange={vi.fn()}
        onSet={vi.fn()}
        onClear={vi.fn()}
        onRunNow={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-supervisor-run-now-button')).toBeDisabled()
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
