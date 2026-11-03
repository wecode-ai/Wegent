import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ComponentType } from 'react'
import { DshAppSurface } from './DshAppSurface'
import { DshRouteSurface } from './DshRouteSurface'
import { DshSettingsSurface } from './DshSettingsSurface'
import { clearDshUiModuleCache } from './dshUiModules'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

const modulePath = 'plugins/first-use-page-test.js'
const tab = { id: 'test', kind: 'task' as const, title: 'Test', contentRoute: '/' }
const surfaces = [
  {
    name: 'route',
    loadingId: 'dsh-route-loading',
    render: () => (
      <DshRouteSurface
        route={{
          id: 'sites',
          label: '应用',
          module: modulePath,
          path: '/sites',
          telemetryFeature: 'sites',
        }}
        search=""
        workspaceTabId="test"
      />
    ),
  },
  {
    name: 'app',
    loadingId: 'dsh-app-loading',
    render: () => (
      <DshAppSurface
        active
        app={{ id: 'test', label: 'Test', mode: 'native', module: modulePath }}
        tab={tab}
      />
    ),
  },
  {
    name: 'settings',
    loadingId: 'dsh-settings-loading',
    render: () => (
      <DshSettingsSurface
        devices={[]}
        onBack={() => {}}
        onOpenCloudSettings={() => {}}
        page={{
          id: 'test',
          label: 'Test',
          category: 'test',
          categoryLabel: 'Test',
          path: '/settings/test',
          module: modulePath,
        }}
      />
    ),
  },
]

describe('first-use page loading', () => {
  beforeEach(() => clearDshUiModuleCache())
  afterEach(() => {
    delete window.__WEWORK_DSH_UI_MODULES__
    clearDshUiModuleCache()
  })

  test.each(surfaces)(
    '$name shows feedback until a cold module finishes and reuses it on reentry',
    async surface => {
      let finish!: (module: { default: ComponentType }) => void
      const pending = new Promise<{ default: ComponentType }>(resolve => {
        finish = resolve
      })
      const load = vi.fn(() => pending)
      window.__WEWORK_DSH_UI_MODULES__ = { [modulePath]: load }

      let first!: ReturnType<typeof render>
      await act(async () => {
        first = render(surface.render())
      })

      expect(screen.getByTestId(surface.loadingId)).toBeVisible()
      expect(screen.getByRole('status')).toHaveTextContent('加载中')
      expect(screen.queryByText('页面已就绪')).not.toBeInTheDocument()
      await act(async () => {
        first.rerender(surface.render())
      })
      expect(load).toHaveBeenCalledOnce()

      await act(async () => {
        finish({ default: () => <h1>页面已就绪</h1> })
      })

      expect(screen.getByRole('heading', { name: '页面已就绪' })).toBeVisible()
      expect(screen.queryByTestId(surface.loadingId)).not.toBeInTheDocument()
      first.unmount()
      render(surface.render())
      expect(screen.getByRole('heading', { name: '页面已就绪' })).toBeVisible()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(load).toHaveBeenCalledOnce()
    }
  )
})
