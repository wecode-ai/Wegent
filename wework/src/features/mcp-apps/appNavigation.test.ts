import { describe, expect, it, vi } from 'vitest'
import { appNavigationTargets, openAppNavigation } from './appNavigation'

const navigation = vi.hoisted(() => ({ navigateTo: vi.fn(), openScheme: vi.fn() }))
vi.mock('@/lib/navigation', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/navigation')>()),
  navigateTo: navigation.navigateTo,
}))
vi.mock('@/features/notifications/schemeEvents', () => ({
  openWeworkScheme: navigation.openScheme,
}))
vi.mock('@/features/dsh-runtime/dshRoutes', () => ({
  getDshRoutes: () => [{ id: 'schedules', path: '/automations', title: 'Scheduled' }],
}))
vi.mock('@/features/dsh-runtime/dshSettings', () => ({
  getDshSettingsPages: () => [
    { id: 'archives', path: '/settings/archives', label: 'Archived tasks' },
  ],
}))
vi.mock('@/features/dsh-runtime/dshApps', () => ({
  getDshApps: () => [
    { id: 'extension', label: 'Extension' },
    { id: 'hidden', label: 'Hidden', hidden: true },
  ],
  resolveDshApp: (id: string) => ({ id, mode: 'iframe', path: '/ignored-for-iframe' }),
}))

describe('generated HTML navigation', () => {
  it('discovers existing feature entries without a business-specific registry', () => {
    expect(appNavigationTargets()).toEqual([
      expect.objectContaining({ id: 'schedules', path: '/automations' }),
      expect.objectContaining({ id: 'archives', path: '/settings/archives' }),
      expect.objectContaining({ id: 'extension', path: '/app/extension' }),
    ])
  })

  it('opens registered routes and addressed conversations through existing handlers', () => {
    for (const path of [
      '/automations',
      '/settings/archives',
      '/app/extension',
      '/runtime-tasks?deviceId=device&taskId=task',
    ]) {
      expect(openAppNavigation(`wework://navigate/${encodeURIComponent(path)}`)).toBe(true)
      expect(navigation.navigateTo).toHaveBeenLastCalledWith(path)
    }
    navigation.openScheme.mockReturnValueOnce(true)
    expect(openAppNavigation('wework://tasks/device/task')).toBe(true)
    expect(navigation.openScheme).toHaveBeenLastCalledWith('wework://tasks/device/task')
  })

  it.each([
    'https://outside.example',
    'javascript:alert(1)',
    'wework://navigate/%',
    'wework://navigate/%2F%2Foutside.example',
    'wework://navigate/%2F%5Coutside.example',
    'wework://navigate/%2F%00',
    'wework://navigate/%2Fsettings%2Funknown',
    'wework://navigate/%2Fruntime-tasks',
    'wework://navigate/%2Fruntime-tasks%3FtaskId%3Dtask',
    'wework://navigate/%2Fautomations?redirect=outside',
    'wework://user@navigate/%2Fautomations',
  ])('rejects unavailable or malformed destinations: %s', value => {
    expect(openAppNavigation(value)).toBe(false)
  })
})
