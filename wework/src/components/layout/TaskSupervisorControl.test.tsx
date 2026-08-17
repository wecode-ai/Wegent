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

function expectSelectedSupervisorModel(value: string) {
  expect(screen.getByTestId('task-supervisor-model')).toHaveAttribute('data-value', value)
}

function selectSupervisorModel(name: string) {
  fireEvent.click(screen.getByTestId('model-selector-button'))
  fireEvent.click(screen.getByTestId('model-control-menu-model'))
  fireEvent.click(screen.getByTestId(`model-option-${name}`))
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
            name: 'review-model',
            type: 'public',
            displayName: 'Review Model',
            namespace: 'default',
            resourceUserId: 0,
          },
          {
            name: 'gpt-5.6-luna',
            type: 'public',
            displayName: 'GPT 5.6 Luna',
            namespace: 'default',
            resourceUserId: 0,
          },
        ]}
        onSet={onSet}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByTestId('task-supervisor-model')).toHaveTextContent('Review Model')
    selectSupervisorModel('gpt-5.6-luna')
    expect(screen.getByTestId('task-supervisor-model')).toHaveTextContent('GPT 5.6 Luna')
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
            reasoning: 'high',
            weworkCloudModelNamespace: 'default',
            weworkCloudModelResourceUserId: '0',
          },
        },
        60
      )
    )
  })

  test('shows and remembers runtime models from the conversation model list', async () => {
    const onSet = vi.fn().mockResolvedValue(supervisor)
    render(
      <TaskSupervisorControl
        supervisor={null}
        open
        onOpenChange={vi.fn()}
        models={[
          {
            name: 'gpt-5.6-sol',
            type: 'runtime',
            displayName: 'GPT 5.6 Sol',
            provider: 'local',
            config: {
              protocol: 'openai-responses',
              ui: {
                family: 'codex-official',
                modelLabel: 'GPT 5.6 Sol',
                reasoningEfforts: ['low', 'high'],
                defaultReasoningEffort: 'high',
              },
            },
          },
          {
            name: 'k3',
            type: 'runtime',
            displayName: 'k3',
            provider: 'local',
            config: {
              protocol: 'openai-responses',
              ui: {
                family: 'model-interface',
                modelLabel: 'k3',
                reasoningEfforts: ['low', 'high'],
                defaultReasoningEffort: 'low',
              },
            },
          },
        ]}
        onSet={onSet}
        onClear={vi.fn()}
      />
    )

    selectSupervisorModel('k3')
    expectSelectedSupervisorModel('runtime:k3::')
    fireEvent.click(screen.getByTestId('task-supervisor-save-button'))

    await waitFor(() =>
      expect(onSet).toHaveBeenCalledWith(
        'auto',
        '',
        {
          modelName: 'k3',
          modelType: 'runtime',
          options: {
            reasoning: 'low',
          },
        },
        30
      )
    )
  })

  test('defaults to the last selected supervisor model', () => {
    render(
      <TaskSupervisorControl
        supervisor={null}
        open
        defaultModelSelection={{
          modelName: 'saved-review-model',
          modelType: 'public',
        }}
        onOpenChange={vi.fn()}
        models={[
          {
            name: 'first-model',
            type: 'public',
            namespace: 'default',
            resourceUserId: 0,
          },
          {
            name: 'saved-review-model',
            type: 'public',
            namespace: 'default',
            resourceUserId: 0,
          },
        ]}
        onSet={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expectSelectedSupervisorModel('public:saved-review-model:default:0')
  })

  test('selects a model when the cloud catalog loads after the dialog opens', () => {
    const onSet = vi.fn()
    const { rerender } = render(
      <TaskSupervisorControl
        supervisor={null}
        open
        onOpenChange={vi.fn()}
        models={[]}
        onSet={onSet}
        onClear={vi.fn()}
      />
    )

    expectSelectedSupervisorModel('')
    expect(screen.getByTestId('task-supervisor-save-button')).toBeDisabled()

    rerender(
      <TaskSupervisorControl
        supervisor={null}
        open
        onOpenChange={vi.fn()}
        models={[
          {
            name: 'late-review-model',
            type: 'public',
            namespace: 'default',
            resourceUserId: 0,
          },
        ]}
        onSet={onSet}
        onClear={vi.fn()}
      />
    )

    expectSelectedSupervisorModel('public:late-review-model:default:0')
    expect(screen.getByTestId('task-supervisor-save-button')).toBeEnabled()
  })

  test('restores a saved model by its complete cloud identity', () => {
    render(
      <TaskSupervisorControl
        supervisor={null}
        open
        defaultModelSelection={{
          modelName: 'shared-name',
          modelType: 'public',
          options: {
            weworkCloudModelNamespace: 'team-b',
            weworkCloudModelResourceUserId: '22',
          },
        }}
        onOpenChange={vi.fn()}
        models={[
          {
            name: 'shared-name',
            type: 'public',
            namespace: 'team-a',
            resourceUserId: 11,
          },
          {
            name: 'shared-name',
            type: 'public',
            namespace: 'team-b',
            resourceUserId: 22,
          },
        ]}
        onSet={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expectSelectedSupervisorModel('public:shared-name:team-b:22')
  })

  test('keeps the configured supervisor model visible when the cloud catalog is unavailable', async () => {
    const onSet = vi.fn().mockResolvedValue(supervisor)
    render(
      <TaskSupervisorControl
        open
        supervisor={{
          ...supervisor,
          modelSelection: {
            modelName: 'saved-review-model',
            modelType: 'public',
            options: {
              weworkCloudModelNamespace: 'default',
              weworkCloudModelResourceUserId: '0',
            },
          },
        }}
        models={[]}
        onOpenChange={vi.fn()}
        onSet={onSet}
        onClear={vi.fn()}
      />
    )

    expectSelectedSupervisorModel('public:saved-review-model:default:0')
    expect(screen.getByTestId('task-supervisor-model')).toHaveTextContent('saved-review-model')

    fireEvent.click(screen.getByTestId('task-supervisor-save-button'))
    await waitFor(() =>
      expect(onSet).toHaveBeenCalledWith(
        'suggest',
        'Keep the task focused',
        {
          modelName: 'saved-review-model',
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

  test('defaults to the last selected supervisor interval', () => {
    render(
      <TaskSupervisorControl
        supervisor={null}
        open
        defaultIntervalSeconds={300}
        onOpenChange={vi.fn()}
        onSet={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-supervisor-frequency')).toHaveValue('300')
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
    expectSelectedSupervisorModel('public:gpt-5.6-luna:default:0')
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

    expectSelectedSupervisorModel('public:review-model:default:0')
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

    expect(screen.getByTestId('task-supervisor-status-icon')).toHaveAccessibleName(
      'workbench.supervisor_active'
    )

    rerender(
      <TaskSupervisorStatusButton
        supervisor={{ ...supervisor, status: 'checking' }}
        onClick={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-supervisor-status-icon')).toHaveAccessibleName(
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

    expect(screen.getByTestId('task-supervisor-status-icon')).toHaveAccessibleName(
      'workbench.supervisor_aligned'
    )
  })

  test('shows the next scheduled check and runs supervision from the status row', async () => {
    const onRunNow = vi.fn().mockResolvedValue(supervisor)
    render(
      <TaskSupervisorStatusButton
        supervisor={{
          ...supervisor,
          lastEvaluatedAt: Date.now(),
          intervalSeconds: 30,
        }}
        onClick={vi.fn()}
        onRunNow={onRunNow}
      />
    )

    expect(screen.getByTestId('task-supervisor-status-next-check')).toHaveTextContent(
      'workbench.supervisor_next_check'
    )
    const statusRow = screen.getByTestId('task-supervisor-status-row')
    expect(statusRow).toContainElement(screen.getByTestId('task-supervisor-toggle-button'))
    expect(statusRow).toContainElement(screen.getByTestId('task-supervisor-status-next-check'))
    expect(statusRow).toContainElement(screen.getByTestId('task-supervisor-status-run-now-button'))
    expect(screen.getByTestId('task-supervisor-status-run-now-button')).toHaveAccessibleName(
      'workbench.supervisor_run_now'
    )
    fireEvent.click(screen.getByTestId('task-supervisor-status-run-now-button'))
    await waitFor(() => expect(onRunNow).toHaveBeenCalledOnce())
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
