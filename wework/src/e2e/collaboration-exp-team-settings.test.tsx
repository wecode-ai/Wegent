import { useState } from 'react'
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

function rendererControl() {
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
        if (url.endsWith('/results')) result = JSON.parse(String(request?.body))
        return Response.json({})
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
