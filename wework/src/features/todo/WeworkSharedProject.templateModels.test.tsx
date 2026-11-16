import '@/i18n'
import { fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { runnerModelKey, type CollaborationApp, type RunnerModel } from '@wegent/collaboration'
import { TemplateModelSelection } from '../../../../packages/collaboration/src/templates/TemplateModelSelection'
import { WeworkSharedProject } from './WeworkCollaborationPlatform'

const captured = vi.hoisted(() => ({
  host: null as ComponentProps<typeof CollaborationApp>['host'] | null,
}))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => false,
}))
vi.mock('@wegent/collaboration', async importOriginal => ({
  ...(await importOriginal<typeof import('@wegent/collaboration')>()),
  CollaborationApp: ({ host }: ComponentProps<typeof CollaborationApp>) => {
    captured.host = host
    return (
      <TemplateModelSelection
        runtime="codex"
        configuration={{
          host: host.projectAgentConfiguration!,
          location: 'cloud',
          projectId: 'cloud-project',
        }}
        locale="en"
        disabled={false}
        onChange={() => {}}
      />
    )
  },
}))

it('retains the selected cloud import model across device refreshes without enabling local Agent creation', async () => {
  const model: RunnerModel = {
    runtime: 'codex',
    provider: 'company',
    model_id: 'selected',
    label: 'Selected',
    local_model_id: 'selected',
    account_label: 'Company',
    is_default: false,
  }
  const listEnvironments = vi.fn(async () => [
    { id: '42', device_key: 'device', status: 'online', project_authorized: true },
  ])
  const project = { id: 'cloud-project', name: 'Cloud project', project_store: 'backend' }
  const props = {
    api: { projects: {}, issues: {} },
    project,
    localProjects: [],
    locale: 'en',
    location: { projectId: project.id, projectView: 'manage', issueId: null },
    services: {
      localProjectChatAgentApi: {
        listRunnerEnvironments: async () => [
          { id: 'device', device_key: 'device', models: [model] },
        ],
        listModels: async () => [],
      },
      agentResourceApi: { listEnvironments },
    },
    userId: 7,
    workspace: { id: 'space', name: 'Cloud space' },
    setLocation: vi.fn(),
  } as unknown as ComponentProps<typeof WeworkSharedProject>
  const { getByRole, rerender } = render(<WeworkSharedProject {...props} />)
  const configuration = captured.host!.projectAgentConfiguration!
  const field = getByRole('combobox')
  await waitFor(() => expect(getByRole('option', { name: /Selected/ })).toBeEnabled())
  fireEvent.change(field, { target: { value: runnerModelKey(model) } })
  expect(field).toHaveValue(runnerModelKey(model))
  rerender(<WeworkSharedProject {...props} devices={[]} />)
  await waitFor(() => expect(field).toHaveValue(runnerModelKey(model)))
  expect(captured.host!.projectAgentConfiguration).toBe(configuration)
  expect(configuration.listTemplateAgentModels).toBeTypeOf('function')
  expect(configuration.renderLocalAgentCreator).toBeUndefined()
  expect((await configuration.listTemplateAgentModels!('codex')).models).toEqual([model])
  expect(
    await configuration.resolveTemplateAgentRouting!('codex', 'cloud', project.id, undefined, model)
  ).toMatchObject({
    executionPolicy: { mode: 'fixed', environment_id: '42' },
    modelPolicy: { mode: 'fixed', model: { model_id: 'selected' } },
  })
  expect(listEnvironments).toHaveBeenCalledWith(project.id)
  listEnvironments.mockResolvedValue([])
  await expect(
    configuration.resolveTemplateAgentRouting!('codex', 'cloud', project.id, undefined, model)
  ).rejects.toThrow('template_environment_unavailable')
})
