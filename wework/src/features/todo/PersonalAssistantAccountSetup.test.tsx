import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { PersonalAssistantAccountSetup } from './PersonalAssistantAccountSetup'
import { personalAssistantDeviceSettings } from './personalAssistantDeviceSettings'

const account: PersonalAssistantAccount = {
  defaultBotRef: { name: 'primary', namespace: 'personal-assistant' },
  revision: 'current',
  retiredRoleIds: [],
  definitions: [],
}
const blank: PersonalStandInSettings = {
  userId: 7,
  executionDeviceId: 'mac',
  version: 0,
  roles: [],
}

function setup(initial: PersonalAssistantAccount | Error | null, local = blank) {
  const get = vi.fn(async () => {
    if (initial instanceof Error) throw initial
    return initial
  })
  const personalGet = vi.fn(async () => local)
  const initialize = vi.fn(async () => account)
  const services = {
    personalAssistantAccountApi: { get, initialize },
    standInApi: { personalGet },
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
  } as unknown as WorkbenchServices
  render(
    <PersonalAssistantAccountSetup services={services} userId={7} active>
      {assistant => <p>{assistant?.defaultBotRef.name ?? 'local workspace'}</p>}
    </PersonalAssistantAccountSetup>
  )
  return { get, personalGet, initialize }
}

test('an initialized cloud account opens without probing a legacy profile', async () => {
  const { personalGet, initialize } = setup(account)
  expect(await screen.findByText('primary')).toBeVisible()
  expect(personalGet).not.toHaveBeenCalled()
  expect(initialize).not.toHaveBeenCalled()
})

test('a saved legacy profile requires confirmation before import', async () => {
  const legacy = {
    ...blank,
    version: 1,
    primary: { enabled: true, prompt: 'Handle support requests', preferences: '' },
  }
  const { initialize, personalGet } = setup(null, legacy)
  const confirm = await screen.findByTestId('personal-assistant-account-migrate-confirm')
  expect(initialize).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('personal-assistant-account-migrate-cancel'))
  expect(await screen.findByText('local workspace')).toBeVisible()
  const edited = {
    ...legacy,
    version: 2,
    primary: { ...legacy.primary, prompt: 'Updated locally' },
  }
  personalGet.mockResolvedValue(edited)
  fireEvent.click(screen.getByTestId('personal-assistant-account-initialize'))
  expect(confirm).not.toBeInTheDocument()
  fireEvent.click(await screen.findByTestId('personal-assistant-account-migrate-confirm'))
  expect(await screen.findByText('primary')).toBeVisible()
  expect(initialize).toHaveBeenCalledWith(expect.any(String), edited)
})

test('a missing cloud and legacy profile takes ordinary initialization', async () => {
  const { initialize } = setup(null)
  expect(await screen.findByText('primary')).toBeVisible()
  expect(screen.queryByTestId('personal-assistant-account-migrate-confirm')).toBeNull()
  expect(initialize).toHaveBeenCalledWith(expect.any(String))
})

test('a failed cloud read cannot trigger initialization or local import', async () => {
  const { personalGet, initialize } = setup(new Error('Cloud read failed'))
  expect(await screen.findByTestId('personal-assistant-account-retry')).toBeVisible()
  expect(personalGet).not.toHaveBeenCalled()
  expect(initialize).not.toHaveBeenCalled()
})

test('saving and retrying a new shared role never uploads a device-only profile', async () => {
  const local = { ...newStandInRole('mac', 'local'), name: 'Private device role' }
  const newRole = { ...newStandInRole('mac', 'new'), name: 'New shared role', prompt: 'Review' }
  let device = { ...blank, roles: [local] }
  const updateDefinitions = vi.fn().mockRejectedValueOnce(new Error('Offline'))
  const current = {
    ...account,
    definitions: [
      {
        roleId: '@primary',
        bot: { metadata: { ...account.defaultBotRef, displayName: 'Default' } },
        ghost: { spec: { systemPrompt: 'Default prompt' } },
      },
    ],
  }
  updateDefinitions.mockResolvedValueOnce({
    ...current,
    revision: 'updated',
    definitions: [
      ...current.definitions,
      {
        roleId: newRole.id,
        bot: { metadata: { ...account.defaultBotRef, displayName: newRole.name } },
        ghost: { spec: { systemPrompt: newRole.prompt } },
      },
    ],
  })
  const services = {
    personalAssistantAccountApi: { updateDefinitions, get: async () => current },
    standInApi: {
      personalGet: async () => device,
      async personalSave(_user: number, settings: PersonalStandInSettings) {
        device = { ...settings, version: device.version + 1 }
        return device
      },
    },
  } as unknown as WorkbenchServices
  const api = personalAssistantDeviceSettings(services, () => current, vi.fn()).standInApi!
  const settings = await api.personalGet(7, 'mac')
  await api.personalSave(7, settings, 'mac')
  expect(updateDefinitions).not.toHaveBeenCalled()

  const draft = { ...settings, version: device.version, roles: [...settings.roles, newRole] }
  const change = { kind: 'create', roleId: newRole.id } as const
  await expect(api.personalSave(7, draft, 'mac', undefined, change)).rejects.toMatchObject({
    code: 'cloud_definition_save_unconfirmed',
  })
  expect(device.roles.map(role => role.id)).toEqual([local.id, newRole.id])
  await api.personalSave(7, { ...draft, version: device.version }, 'mac', undefined, change)
  expect(updateDefinitions).toHaveBeenLastCalledWith(current.revision, [
    { roleId: '@primary', name: 'Default', prompt: 'Default prompt' },
    { roleId: newRole.id, name: newRole.name, prompt: newRole.prompt },
  ])
})
