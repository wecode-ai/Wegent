import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { StandInOverviewPage } from './StandInOverviewPage'

vi.mock('./StandInConversation', () => ({ StandInConversation: () => null }))

function renderOverview() {
  const settings = { userId: 7, executionDeviceId: 'device', version: 1, roles: [] }
  const services = {
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'device' }),
    modelApi: { listModels: async () => ({ data: [] }) },
    standInApi: {
      onboarding: async () => ({ state: { version: 1, completed: true } }),
      connectionProviders: async () => ({ items: [] }),
      catalog: async () => ({ models: [] }),
      personalGet: async () => settings,
      personalAgents: async () => [],
      memories: async () => [],
      inbox: async () => ({ items: [], sourceErrors: [] }),
      proposal: async () => null,
      processingStatus: async () => ({ pendingCount: 0, running: false, actions: [] }),
    },
  } as unknown as WorkbenchServices
  render(
    <StandInOverviewPage
      userId={7}
      initialDeviceId="device"
      api={{} as SharedWorkspaceApi}
      services={services}
      devices={[]}
      projects={[]}
    />
  )
}

it('returns keyboard focus to details after closing settings opened from work sources', async () => {
  renderOverview()
  const user = userEvent.setup()
  const trigger = await screen.findByTestId('stand-in-details-open')
  await waitFor(() => expect(trigger).toBeEnabled())
  await user.click(trigger)
  await user.click(await screen.findByTestId('stand-in-details-work-sources'))
  await screen.findByTestId('stand-in-primary-profile')
  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByTestId('stand-in-profile-panel')).not.toBeInTheDocument()
  )
  expect(trigger).toHaveFocus()
})

it('returns focus to the create-role entry after discarding a new role', async () => {
  renderOverview()
  const user = userEvent.setup()
  const trigger = await screen.findByTestId('stand-in-create-role')
  await waitFor(() => expect(trigger).toBeEnabled())
  await user.click(trigger)
  await screen.findByTestId('stand-in-role-name')
  await user.click(screen.getByTestId('stand-in-close'))
  await user.click(await screen.findByTestId('stand-in-discard'))
  await waitFor(() =>
    expect(screen.queryByTestId('stand-in-profile-panel')).not.toBeInTheDocument()
  )
  expect(trigger).toHaveFocus()
  expect(screen.getByTestId('stand-in-details-open')).not.toHaveFocus()
})
