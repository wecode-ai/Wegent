import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { StandInOverviewPage } from '@/features/todo/StandInOverviewPage'
import { standInOverviewFixture } from '@/features/todo/StandInOverviewPage.testFixtures'
import { StandInPrimaryProfile } from '@/features/todo/StandInPrimaryProfile'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { openExplicitModelMenu } from '../../e2e/desktop/modules/model-menu-navigation.mjs'
import {
  openStandInActivity,
  closeStandInActivity,
} from '../../e2e/desktop/modules/stand-in-profile-navigation.mjs'
import { runDesktopControlClient } from './automation'
import '@/i18n'

vi.mock('@/features/todo/StandInWorkConfirmation', () => ({
  StandInWorkConfirmation: () => null,
}))
vi.mock('@/features/todo/StandInConversation', () => ({ StandInConversation: () => null }))
vi.mock('@/components/layout/useProjectWorktreeAvailabilityProbe', () => ({
  useProjectWorktreeAvailabilityProbe: () => null,
}))

function nativeControl() {
  let next: DesktopControlCommand | undefined
  const results: Array<{ ok: boolean; value?: string; error?: string }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/commands?')) {
      const command = next
      next = undefined
      return command ? Response.json(command) : new Response(null, { status: 410 })
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(init?.body)))
    return Response.json({})
  })
  return {
    command: async (action: DesktopControlCommand['action'], selector: string, options = {}) => {
      next = { id: 'stand-in-modal-navigation', action, selector, ...options }
      const resultIndex = results.length
      await act(async () => runDesktopControlClient('http://127.0.0.1:43111', 'main'))
      const result = results[resultIndex]
      if (!result?.ok) throw new Error(result?.error ?? 'Missing control result')
      return result.value ?? ''
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mockVisibleLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 200, 30)
  )
}

it.each(['stand-in-primary-open', 'stand-in-overview-role-project-role'])(
  'requires closing recent activity before switching to %s',
  async testId => {
    mockVisibleLayout()
    const { props } = standInOverviewFixture([
      newStandInRole('device', 'default'),
      { ...newStandInRole('device', 'project-role'), name: 'Project assistant' },
    ])
    render(<StandInOverviewPage {...props} initialSelectedRoleId="default" />)
    await waitFor(() => expect(screen.getByTestId('stand-in-details-open')).toBeEnabled())
    const control = nativeControl()
    await openStandInActivity(control)

    const role = `[data-testid="${testId}"]`
    expect(screen.getByTestId('stand-in-work-dialog')).toBeVisible()
    expect(screen.getByTestId(testId).closest('[inert]')).not.toBeNull()
    await expect(control.command('click', role)).rejects.toThrow('is disabled')

    await closeStandInActivity(control)
    await control.command('clickWhenEnabled', role)
    expect(screen.getByTestId(testId).closest('[inert]')).toBeNull()
    expect(screen.getByTestId(testId)).toHaveAttribute('aria-current', 'page')
  }
)

it('requires dismissing the selected model before saving the stand-in profile', async () => {
  mockVisibleLayout()
  const onSave = vi.fn(async () => {})
  const onClose = vi.fn()
  render(
    <StandInPrimaryProfile
      settings={
        {
          userId: 7,
          executionDeviceId: 'device',
          version: 0,
          roles: [],
          primary: { enabled: true, prompt: '', preferences: '' },
        } as PersonalStandInSettings
      }
      saving={false}
      error={null}
      onSave={onSave}
      onClose={onClose}
      onSelectDevice={vi.fn()}
      localDeviceId="device"
      projects={[]}
      devices={[]}
      services={
        {
          standInApi: {
            catalog: async () => ({
              models: [{ runtime: 'codex', provider: 'local', model_id: 'profile-model' }],
            }),
          },
          modelApi: { listModels: async () => ({ data: [] }) },
          runtimeWorkApi: { listRuntimeWork: async () => ({ chats: [], projects: [] }) },
        } as unknown as WorkbenchServices
      }
    />
  )
  await waitFor(() => expect(screen.getByTestId('model-selector-button')).toBeEnabled())
  const control = nativeControl()
  await openExplicitModelMenu(control, '[data-testid="model-selector-button"]')
  const modelKey = JSON.stringify(['codex', 'local', 'profile-model'])
  await control.command(
    'clickWhenEnabled',
    `[data-testid=${JSON.stringify(`model-option-${modelKey}`)}]`
  )

  const save = screen.getByTestId('stand-in-primary-save')
  expect(save).toBeEnabled()
  expect(save.closest('[inert]')).not.toBeNull()
  await expect(control.command('click', '[data-testid="stand-in-primary-save"]')).rejects.toThrow(
    'is disabled'
  )
  expect(onSave).not.toHaveBeenCalled()

  await control.command('press', '[data-model-selector-layer="true"]', { key: 'Escape' })
  await control.command('waitFor', '[data-testid="model-selector-menu"]', { visible: false })
  expect(onClose).not.toHaveBeenCalled()
  await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      primary: expect.objectContaining({
        model: expect.objectContaining({ model_id: 'profile-model' }),
      }),
    })
  )
})
