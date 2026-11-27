import { useState } from 'react'
import { createHttpClient } from '@/api/http'
import {
  createPersonalAssistantAccountApi,
  type PersonalAssistantAccount,
} from '@/api/personalAssistantAccount'
import { newStandInRole } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { PersonalAssistantAccountSetup } from '@/features/todo/PersonalAssistantAccountSetup'
import {
  createCollaborationExpCloudRequest,
  migrateCollaborationExpAssistant,
} from '../../e2e/desktop/modules/collaboration-exp-account-setup.mjs'
import {
  COLLABORATION_EXP_RHYTHM_ROLE,
  COLLABORATION_EXP_RHYTHM_MARKER,
} from '../../e2e/desktop/modules/collaboration-exp-rhythm.mjs'
import { createPortal } from 'react-dom'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { verifyCollaborationExpTeamManagement } from '../../e2e/desktop/modules/collaboration-exp-viewport-flows.mjs'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import type { DesktopControlResult } from './desktop-control-command'
import { runDesktopControlClient } from './automation'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Fault = 'role' | 'task' | 'issue'

function SettingsPortal({ active, name }: { active: boolean; name: string }) {
  return createPortal(
    <div
      data-testid="stand-in-profile-backdrop"
      inert={!active}
      style={{ display: active ? undefined : 'none' }}
    >
      <aside data-testid="stand-in-profile-panel" role="dialog">
        <input data-testid="stand-in-role-name" defaultValue={name} />
      </aside>
    </div>,
    document.body
  )
}

function ManagementFixture({ fault, onOpen }: { fault?: Fault; onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <section data-workspace-tab-content="" aria-hidden="false">
        <button
          data-testid="running-role"
          onClick={() => {
            onOpen()
            setOpen(true)
          }}
        >
          Integration assistant
        </button>
      </section>
      <SettingsPortal active={false} name="Integration assistant" />
      {open && (
        <SettingsPortal
          active
          name={fault === 'role' ? 'Another assistant' : 'Integration assistant'}
        />
      )}
    </>
  )
}

function rendererControl(applicationFetch?: typeof fetch) {
  const commands: DesktopControlCommand[] = []
  return {
    commands,
    async command(action: string, selector: string, options: Partial<DesktopControlCommand> = {}) {
      const command = { ...options, id: String(commands.length), action, selector }
      commands.push(command)
      let delivered = false
      let result: DesktopControlResult | undefined
      vi.stubGlobal('fetch', async (url: string, request?: RequestInit) => {
        if (url.includes('/commands?')) {
          if (delivered) return new Response(null, { status: 410 })
          delivered = true
          return Response.json(command)
        }
        if (url.endsWith('/results')) {
          result = JSON.parse(String(request?.body))
          return Response.json({})
        }
        if (url.startsWith('http://127.0.0.1:43111/')) return Response.json({})
        return applicationFetch ? applicationFetch(url, request) : Response.json({})
      })
      await runDesktopControlClient('http://127.0.0.1:43111', 'main')
      if (!result?.ok) throw new Error(result?.error ?? 'Missing renderer control result')
      return result.value ?? ''
    },
  }
}

async function verifyManagement(fault?: Fault) {
  const tasks = ['native-task']
  const issues = ['shared-issue']
  render(
    <ManagementFixture
      fault={fault}
      onOpen={() => {
        if (fault === 'task') tasks.push('unexpected-task')
        if (fault === 'issue') issues.push('unexpected-issue')
      }}
    />
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 100, 30)
  )
  const control = rendererControl()
  await verifyCollaborationExpTeamManagement({
    control,
    runningRole: '[data-testid="running-role"]',
    click: (target: typeof control, selector: string) =>
      target.command('clickWhenEnabled', selector),
    nativeTaskIdentities: async () => [...tasks],
    localIssueIdentities: async () => [...issues],
  })
  return control.commands
}

test('verifies the exact active body-portal role through actual renderer control, ignoring an inactive retained panel', async () => {
  const commands = await verifyManagement()
  expect(
    document.querySelector(
      '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-role-name"]'
    )
  ).toBeNull()
  expect(document.querySelectorAll('[data-testid="stand-in-role-name"]')).toHaveLength(2)
  expect(commands.map(command => command.action)).toEqual([
    'clickWhenEnabled',
    'waitFor',
    'getValue',
  ])
  for (const command of commands.slice(1))
    expect(command.selector).toBe(
      '[data-testid="stand-in-profile-backdrop"]:not([inert]) [data-testid="stand-in-profile-panel"] [data-testid="stand-in-role-name"]'
    )
})

test('rejects the wrong active role even when an inactive portal has the expected name', async () => {
  await expect(verifyManagement('role')).rejects.toThrow('Integration assistant')
})

test.each(['task', 'issue'] as const)(
  'rejects management navigation that unexpectedly creates a %s',
  async fault => {
    await expect(verifyManagement(fault)).rejects.toThrow('unexpected-')
  }
)

function AccountManagementFixture({ services }: { services: WorkbenchServices }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <section data-workspace-tab-content="" aria-hidden="false">
        <button data-testid="running-role" onClick={() => setOpen(true)}>
          Integration assistant
        </button>
      </section>
      <PersonalAssistantAccountSetup services={services} userId={7} active>
        {() => (
          <div data-testid="stand-in-overview">
            {open && <SettingsPortal active name="Integration assistant" />}
          </div>
        )}
      </PersonalAssistantAccountSetup>
    </>
  )
}

type MigrationFault =
  | 'id'
  | 'name'
  | 'prompt'
  | 'device'
  | 'missing-role'
  | 'extra-role'
  | 'task'
  | 'issue'

async function migrateAndManage(fault?: MigrationFault) {
  const deviceId = 'electron-collaboration-exp'
  const role = {
    ...newStandInRole(deviceId, COLLABORATION_EXP_RHYTHM_ROLE),
    name: 'Integration assistant',
    prompt: COLLABORATION_EXP_RHYTHM_MARKER,
    enabled: true,
  }
  const sibling = {
    ...newStandInRole(deviceId, 'existing-role'),
    name: 'Existing assistant',
    prompt: 'Preserve this role',
  }
  const settings = { userId: 7, executionDeviceId: deviceId, version: 3, roles: [role, sibling] }
  const tasks = ['native-task']
  const issues = ['shared-issue']
  let account: PersonalAssistantAccount | null = null
  const imports: unknown[] = []
  const applicationFetch: typeof fetch = async (input, init) => {
    expect(String(input)).toBe('http://127.0.0.1:43112/api/v1/personal-assistant')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer migration-contract-token')
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body))
      imports.push(payload)
      account = {
        defaultBotRef: { name: 'bot-0', namespace: 'personal-assistant' },
        revision: 'migrated',
        retiredRoleIds: [],
        definitions: payload.definitions.map(
          (
            definition: { roleId: string; name: string; prompt: string; executionDeviceId: string },
            index: number
          ) => ({
            roleId: definition.roleId,
            bot: {
              metadata: {
                name: 'bot-' + index,
                namespace: 'personal-assistant',
                displayName: definition.name,
              },
              spec: {
                execution_policy: { mode: 'fixed', environment_id: definition.executionDeviceId },
              },
            },
            ghost: { spec: { systemPrompt: definition.prompt } },
          })
        ),
      }
      const migratedRole = account.definitions.find(definition => definition.roleId === role.id)!
      if (fault === 'id') migratedRole.roleId = 'another-role'
      if (fault === 'name') migratedRole.bot.metadata.displayName = 'Another assistant'
      if (fault === 'prompt') migratedRole.ghost.spec.systemPrompt = 'Lost prompt'
      if (fault === 'device')
        migratedRole.bot.spec!.execution_policy!.environment_id = 'another-device'
      if (fault === 'missing-role')
        account.definitions = account.definitions.filter(
          definition => definition.roleId !== sibling.id
        )
      if (fault === 'extra-role')
        account.definitions.push({ ...migratedRole, roleId: 'unexpected-role' })
      if (fault === 'task') tasks.push('unexpected-task')
      if (fault === 'issue') issues.push('unexpected-issue')
    }
    return Response.json({ assistant: account })
  }
  const api = createPersonalAssistantAccountApi(
    createHttpClient({
      baseUrl: 'http://127.0.0.1:43112/api',
      getToken: () => 'migration-contract-token',
    })
  )
  vi.stubGlobal('fetch', applicationFetch)
  const services = {
    personalAssistantAccountApi: api,
    standInApi: {
      personalGet: async () => settings,
      binding: async () => ({ target: { userId: settings.userId, deviceId } }),
    },
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId }),
  } as unknown as WorkbenchServices
  render(<AccountManagementFixture services={services} />)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 100, 30)
  )
  const control = rendererControl(applicationFetch)
  const identities = {
    nativeTaskIdentities: async () => [...tasks],
    localIssueIdentities: async () => [...issues],
  }
  await migrateCollaborationExpAssistant({
    control,
    request: createCollaborationExpCloudRequest(
      { backendUrl: 'http://127.0.0.1:43112', authToken: 'migration-contract-token' },
      10000
    ),
    settings,
    returnRoute: '/collaboration-exp?view=assistant',
    ...identities,
  })
  await verifyCollaborationExpTeamManagement({
    control,
    runningRole: '[data-testid="running-role"]',
    click: (target: typeof control, selector: string) =>
      target.command('clickWhenEnabled', selector),
    ...identities,
  })
  expect(imports).toEqual([
    {
      definitions: [
        { roleId: '@primary', name: expect.any(String), prompt: '', executionDeviceId: deviceId },
        { roleId: role.id, name: role.name, prompt: role.prompt, executionDeviceId: deviceId },
        {
          roleId: sibling.id,
          name: sibling.name,
          prompt: sibling.prompt,
          executionDeviceId: deviceId,
        },
      ],
    },
  ])
  return control.commands
}

test('migrates the saved native team through the real account confirmation and HTTP contract before managing its running role', async () => {
  const commands = await migrateAndManage()
  expect(
    commands
      .filter(command => command.action === 'clickWhenEnabled')
      .map(command => command.selector)
  ).toEqual([
    '[data-testid="personal-assistant-account-migrate-confirm"]',
    '[data-testid="running-role"]',
  ])
  expect(document.querySelector('[data-testid="personal-assistant-account-setup"]')).toBeNull()
}, 15000)

test.each([
  'id',
  'name',
  'prompt',
  'device',
  'missing-role',
  'extra-role',
  'task',
  'issue',
] as const)(
  'rejects migration that changes the %s contract',
  async fault => {
    const message = ['id', 'missing-role', 'extra-role'].includes(fault)
      ? 'Cloud migration must preserve every native role ID'
      : fault === 'task'
        ? 'Cloud migration must preserve native task identities'
        : fault === 'issue'
          ? 'Cloud migration must preserve local Issue identities'
          : 'Cloud migration must preserve the role definition'
    await expect(migrateAndManage(fault)).rejects.toThrow(message)
  },
  15000
)
