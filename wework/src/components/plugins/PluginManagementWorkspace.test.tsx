import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { PluginManagementWorkspace } from './PluginManagementWorkspace'

function mockManagementFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const requestUrl = new URL(url, 'http://localhost')
      if (requestUrl.pathname === '/api/plugins/installed') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        })
      }
      if (requestUrl.pathname === '/api/mcps/installed') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        })
      }
      if (requestUrl.pathname === '/api/system-skills/installed') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        })
      }
      if (requestUrl.pathname === '/api/mcp-providers') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ providers: [] }),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
    })
  )
}

describe('PluginManagementWorkspace', () => {
  beforeEach(() => {
    mockManagementFetch()
  })

  test('removes user plugin upload entry from plugin management', async () => {
    render(<PluginManagementWorkspace />)

    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    expect(screen.queryByTestId('plugin-management-upload-plugin-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-management-create-button'))

    expect(screen.queryByTestId('plugins-create-plugin-option')).not.toBeInTheDocument()
  })
})
