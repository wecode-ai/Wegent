import type { LocalCodexPluginApi, LocalPluginImportPreview } from '@/api/local/codexPlugins'
import '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { PluginImportDialog } from './PluginImportDialog'

const desktopHostMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopHostMock,
}))

const validPreview: LocalPluginImportPreview = {
  valid: true,
  archivePath: '/tmp/example-plugin.zip',
  sha256: 'a'.repeat(64),
  name: 'example-plugin',
  displayName: 'Example Plugin',
  version: '1.0.0',
  description: 'Example plugin package',
  skillCount: 1,
  mcpServerCount: 1,
  executableCapabilities: ['stdio MCP: example'],
  existing: false,
  existingVersion: null,
  issues: [],
}

function pluginApi(overrides: Partial<LocalCodexPluginApi> = {}): LocalCodexPluginApi {
  return {
    previewPluginImport: vi.fn().mockResolvedValue(validPreview),
    importPluginPackage: vi.fn().mockResolvedValue({
      pluginName: 'example-plugin',
      displayName: 'Example Plugin',
      version: '1.0.0',
    }),
    savePluginExample: vi.fn().mockResolvedValue('/tmp/wework-plugin-example.zip'),
    ...overrides,
  } as LocalCodexPluginApi
}

describe('PluginImportDialog', () => {
  test('cancels with Escape without importing a package', async () => {
    const onCancel = vi.fn()
    const api = pluginApi()
    render(<PluginImportDialog pluginApi={api} onCancel={onCancel} onImported={vi.fn()} />)
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(api.importPluginPackage).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    desktopHostMock.mockReset()
  })

  test('shows localized guidance for password-protected ZIP files', async () => {
    desktopHostMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/encrypted.zip'],
    })
    const api = pluginApi({
      previewPluginImport: vi.fn().mockResolvedValue({
        ...validPreview,
        valid: false,
        issues: [
          {
            code: 'archive_encrypted',
            path: null,
            message: 'Password required to decrypt file',
          },
        ],
      }),
    })
    render(<PluginImportDialog pluginApi={api} onCancel={vi.fn()} onImported={vi.fn()} />)

    await userEvent.click(screen.getByTestId('plugin-import-select'))

    expect(await screen.findByTestId('plugin-import-issues')).toHaveTextContent(
      '插件 ZIP 已加密，暂不支持需要密码的压缩包'
    )
    expect(screen.queryByText(/Password required/i)).not.toBeInTheDocument()
  })

  test('does not expose raw installation errors in the localized dialog', async () => {
    desktopHostMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/example-plugin.zip'],
    })
    const api = pluginApi({
      previewPluginImport: vi.fn().mockResolvedValue({
        ...validPreview,
        executableCapabilities: [],
      }),
      importPluginPackage: vi
        .fn()
        .mockRejectedValue(new Error('codex_app_server_request_failed: internal error')),
    })
    render(<PluginImportDialog pluginApi={api} onCancel={vi.fn()} onImported={vi.fn()} />)

    await userEvent.click(screen.getByTestId('plugin-import-select'))
    await userEvent.click(await screen.findByTestId('plugin-import-confirm'))

    expect(await screen.findByRole('alert')).toHaveTextContent('插件导入或安装失败，请稍后重试')
    expect(screen.queryByText(/codex_app_server_request_failed/i)).not.toBeInTheDocument()
  })
})
