import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { LOCAL_PLUGIN_SKILLS_CHANGED_EVENT } from '@/features/plugins/pluginTrial'

import { DynamicWorkbenchPluginHost } from './DynamicWorkbenchPluginHost'

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  listDeviceWorkbenchPlugins: vi.fn(),
  listInstalledPlugins: vi.fn(),
  reconcile: vi.fn(),
}))

vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => ({
    listInstalledPlugins: mocks.listInstalledPlugins,
  }),
}))

vi.mock('./bootstrap', () => ({
  getWorkbenchPluginRuntime: () => ({}),
}))

vi.mock('./external', () => ({
  ExternalWorkbenchPluginLoader: class {
    reconcile = mocks.reconcile
    dispose = mocks.dispose
  },
  listDeviceWorkbenchPlugins: mocks.listDeviceWorkbenchPlugins,
}))

function inspectedPlugin(name: string, required = false) {
  return {
    root: `/plugins/${name}`,
    frontendPath: `/plugins/${name}/frontend.js`,
    desktopPath: null,
    manifest: {
      name,
      apiVersion: '1',
      required,
      pinnedToClientVersion: false,
      frontend: {
        entry: 'frontend.js',
        export: 'default',
        sha256: '0'.repeat(64),
      },
      desktop: null,
    },
  }
}

function installedPlugin(name: string, enabled = true) {
  return {
    spec: {
      enabled,
      installState: 'installed',
      source: {
        pluginKey: name,
      },
    },
  }
}

describe('DynamicWorkbenchPluginHost', () => {
  beforeEach(() => {
    mocks.dispose.mockReset().mockResolvedValue(undefined)
    mocks.listDeviceWorkbenchPlugins
      .mockReset()
      .mockResolvedValue([
        inspectedPlugin('installed'),
        inspectedPlugin('disabled'),
        inspectedPlugin('required', true),
      ])
    mocks.listInstalledPlugins.mockReset().mockResolvedValue({
      items: [installedPlugin('installed'), installedPlugin('disabled', false)],
    })
    mocks.reconcile.mockReset().mockResolvedValue(undefined)
  })

  test('loads only locally installed plugins and rescans after local plugin changes', async () => {
    const view = render(<DynamicWorkbenchPluginHost />)

    await waitFor(() => {
      expect(mocks.reconcile).toHaveBeenCalledWith([
        expect.objectContaining({ manifest: expect.objectContaining({ name: 'installed' }) }),
        expect.objectContaining({ manifest: expect.objectContaining({ name: 'required' }) }),
      ])
    })

    mocks.listInstalledPlugins.mockResolvedValue({
      items: [installedPlugin('disabled')],
    })
    act(() => {
      window.dispatchEvent(new Event(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT))
    })

    await waitFor(() => {
      expect(mocks.reconcile).toHaveBeenLastCalledWith([
        expect.objectContaining({ manifest: expect.objectContaining({ name: 'disabled' }) }),
        expect.objectContaining({ manifest: expect.objectContaining({ name: 'required' }) }),
      ])
    })

    view.unmount()
    expect(mocks.dispose).toHaveBeenCalledOnce()
  })
})
