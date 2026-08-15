import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { LocalCodexPluginApi, LocalPluginImportPreview } from '@/api/local/codexPlugins'
import '@/i18n'
import { PluginImportDialog } from './PluginImportDialog'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }))

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
    importPluginPackage: vi.fn().mockResolvedValue({}),
    savePluginExample: vi.fn().mockResolvedValue('/tmp/wework-plugin-example.zip'),
    ...overrides,
  } as LocalCodexPluginApi
}

describe('PluginImportDialog', () => {
  beforeEach(() => {
    vi.mocked(open).mockReset()
    vi.mocked(save).mockReset()
  })

  test('explains how to fix a ZIP with an extra wrapper directory', async () => {
    vi.mocked(open).mockResolvedValue('/tmp/wrapped.zip')
    const api = pluginApi({
      previewPluginImport: vi.fn().mockResolvedValue({
        ...validPreview,
        valid: false,
        issues: [
          {
            code: 'manifest_not_at_root',
            path: 'example-plugin/.codex-plugin/plugin.json',
            message: 'manifest is nested',
          },
        ],
      }),
    })
    render(<PluginImportDialog pluginApi={api} onCancel={vi.fn()} onImported={vi.fn()} />)

    await userEvent.click(screen.getByTestId('plugin-import-select'))

    expect(await screen.findByTestId('plugin-import-issues')).toHaveTextContent(
      '.codex-plugin/plugin.json'
    )
    expect(screen.queryByTestId('plugin-import-confirm')).not.toBeInTheDocument()
  })

  test('shows localized guidance for password-protected ZIP files', async () => {
    vi.mocked(open).mockResolvedValue('/tmp/encrypted.zip')
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

  test('requires trust confirmation before importing executable plugin capabilities', async () => {
    vi.mocked(open).mockResolvedValue('/tmp/example-plugin.zip')
    const importPluginPackage = vi.fn().mockResolvedValue({})
    const onImported = vi.fn()
    const api = pluginApi({ importPluginPackage })
    render(<PluginImportDialog pluginApi={api} onCancel={vi.fn()} onImported={onImported} />)

    await userEvent.click(screen.getByTestId('plugin-import-select'))
    const confirm = await screen.findByTestId('plugin-import-confirm')
    expect(confirm).toBeDisabled()

    await userEvent.click(screen.getByTestId('plugin-import-risk-confirm'))
    await userEvent.click(confirm)

    await waitFor(() => expect(importPluginPackage).toHaveBeenCalledWith(validPreview, false))
    expect(onImported).toHaveBeenCalledOnce()
  })

  test('does not expose raw installation errors in the localized dialog', async () => {
    vi.mocked(open).mockResolvedValue('/tmp/example-plugin.zip')
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

  test('saves the bundled example package to the selected path', async () => {
    vi.mocked(save).mockResolvedValue('/tmp/example.zip')
    const savePluginExample = vi.fn().mockResolvedValue('/tmp/example.zip')
    const api = pluginApi({ savePluginExample })
    render(<PluginImportDialog pluginApi={api} onCancel={vi.fn()} onImported={vi.fn()} />)

    await userEvent.click(screen.getByTestId('plugin-import-download-example'))

    await waitFor(() => expect(savePluginExample).toHaveBeenCalledWith('/tmp/example.zip'))
    expect(await screen.findByTestId('plugin-import-example-saved')).toHaveTextContent(
      '/tmp/example.zip'
    )
  })
})
