import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { RunnerEnvironment } from '@wegent/collaboration'
import { AgentEnvironmentFields, AgentModelFields } from './AgentRoutingFields'
import { useAgentRouting } from './useAgentRouting'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it('opens the existing device picker from the cloud-empty state and uses native models only after selection', async () => {
  const environment: RunnerEnvironment = {
    id: 'local-device',
    name: 'Local Executor',
    device_key: 'local-device',
    owner_type: 'user',
    owner_id: '1',
    status: 'online',
    project_authorized: true,
    runtimes: ['codex'],
    models: [],
  }
  const api = {
    listEnvironments: vi.fn(async () => [environment]),
    listModels: vi.fn(async () => []),
    listNativeModels: vi.fn(async () => ({
      models: [
        {
          runtime: 'codex' as const,
          provider: 'openai',
          model_id: 'native-model',
          label: 'Native model',
          local_model_id: 'native-model',
          account_label: 'Personal',
        },
      ],
    })),
  }
  function Fields() {
    const routing = useAgentRouting(api, 'codex', 'project', { creation: true })
    return (
      <>
        <AgentEnvironmentFields routing={routing} prefix="recovery" disabled={false} />
        <AgentModelFields routing={routing} prefix="recovery" disabled={false} />
        <output data-testid="routing-valid">{String(routing.valid)}</output>
      </>
    )
  }
  render(<Fields />)
  await waitFor(() => expect(screen.getByTestId('recovery-choose-device')).toBeVisible())
  expect(api.listNativeModels).not.toHaveBeenCalled()
  expect(screen.getByTestId('routing-valid')).toHaveTextContent('false')
  fireEvent.click(screen.getByTestId('recovery-choose-device'))
  await waitFor(() =>
    expect(screen.getByTestId('recovery-environment-option-local-device')).toBeVisible()
  )
  fireEvent.click(screen.getByTestId('recovery-environment-option-local-device'))
  await waitFor(() => expect(screen.getByTestId('routing-valid')).toHaveTextContent('true'))
  expect(api.listNativeModels).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'local-device' }),
    'project'
  )
  expect(screen.getByTestId('recovery-model')).toHaveDisplayValue(
    'Native model · workbench.runner_model_native'
  )
  expect(screen.queryByTestId('recovery-model-empty')).not.toBeInTheDocument()
})
