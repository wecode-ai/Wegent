import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { requestRunnerSelection, type RunnerSelectionRequest } from '@/lib/runner-selection'
import { RunnerSelectionHost } from './RunnerSelectionHost'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const request: RunnerSelectionRequest = {
  runtime: 'codex',
  execution_policy: { mode: 'user_select' },
  model_policy: { mode: 'user_select' },
  cloud_only: false,
  cloud_models: [],
  environments: [
    {
      id: 'device',
      device_key: 'device',
      name: 'Project device',
      owner_type: 'user',
      owner_id: '1',
      status: 'online',
      project_authorized: true,
      models: [
        {
          runtime: 'codex',
          provider: 'openai',
          model_id: 'model',
          source: 'native',
          label: 'Native model',
          local_model_id: 'native-model',
          account_label: 'Test account',
          is_default: true,
        },
      ],
    },
  ],
}

describe('window runner selection host', () => {
  test('confirms the selected environment and model after StrictMode registration', async () => {
    render(
      <StrictMode>
        <RunnerSelectionHost />
      </StrictMode>
    )
    let result!: ReturnType<typeof requestRunnerSelection>
    await act(async () => {
      result = requestRunnerSelection(request)
    })
    fireEvent.click(screen.getByTestId('runner-selection-environment'))
    fireEvent.click(await screen.findByTestId('runner-selection-environment-option-device'))
    const model = screen.getByTestId('runner-selection-model')
    await waitFor(() => expect(model).toBeEnabled())
    await waitFor(() => expect(model.querySelectorAll('option')).toHaveLength(2))
    fireEvent.change(model, { target: { value: model.querySelectorAll('option')[1].value } })
    await waitFor(() => expect(screen.getByTestId('runner-selection-confirm')).toBeEnabled())
    fireEvent.click(screen.getByTestId('runner-selection-confirm'))
    await expect(result).resolves.toEqual({
      execution_policy: { mode: 'fixed', environment_id: 'device' },
      model: { runtime: 'codex', provider: 'openai', model_id: 'model', source: 'native' },
    })
    expect(screen.queryByTestId('runner-selection-dialog')).not.toBeInTheDocument()
  })

  test('cancels one request without losing the queue and rejects pending requests on unmount', async () => {
    const view = render(<RunnerSelectionHost />)
    let first!: ReturnType<typeof requestRunnerSelection>
    let second!: ReturnType<typeof requestRunnerSelection>
    await act(async () => {
      first = requestRunnerSelection(request)
      second = requestRunnerSelection(request)
      void first.catch(() => undefined)
      void second.catch(() => undefined)
    })
    expect(screen.getAllByTestId('runner-selection-dialog')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('runner-selection-cancel'))
    await expect(first).rejects.toThrow('workbench.runner_selection_cancelled')
    expect(screen.getAllByTestId('runner-selection-dialog')).toHaveLength(1)
    view.unmount()
    await expect(second).rejects.toThrow('Runner selection dialog closed')
    await expect(requestRunnerSelection(request)).rejects.toThrow('RUNNER_SELECTION_REQUIRED')
  })
})
