import { describe, expect, test, vi } from 'vitest'
import { app, dialog, type BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import {
  confirmCoreDshPluginInstall,
  coreDshPluginInstallDialog,
} from './core-dsh-plugin-approval.js'

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en-US') },
  dialog: { showMessageBox: vi.fn() },
}))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))

const copy = (language: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../src/i18n/locales/${language}/common.json`, import.meta.url),
      'utf8'
    )
  ).workbench
vi.mocked(readFile).mockImplementation(async path =>
  JSON.stringify(copy(String(path).includes('zh-CN') ? 'zh-CN' : 'en'))
)

describe('native Core plugin approval', () => {
  test('escapes source direction controls without changing the installation request', () => {
    const request = { action: 'install' as const, spec: 'plugin\u202etgz' }
    const options = coreDshPluginInstallDialog(request, copy('en'))
    expect(options.detail).toContain('plugin\\u202etgz')
    expect(options.detail).not.toContain('\u202e')
    expect(request.spec).toBe('plugin\u202etgz')
  })
  test.each(['en', 'zh-CN'])(
    'uses a safe default and displays the literal source in %s',
    language => {
      const spec = 'https://example.test/plugin.tgz\nAllow installation'
      const options = coreDshPluginInstallDialog({ action: 'install', spec }, copy(language))
      expect(options.detail).toContain(JSON.stringify(spec))
      expect(options.detail).not.toContain('plugin.tgz\nAllow installation')
      expect(options).toMatchObject({ defaultId: 0, cancelId: 0, type: 'warning', noLink: true })
      expect(options.buttons).toHaveLength(2)
    }
  )

  test.each([0, 1, -1, 2])('accepts only the explicit allow response (%s)', async response => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response, checkboxChecked: false })
    const parent = { isDestroyed: () => false } as BrowserWindow
    expect(
      await confirmCoreDshPluginInstall({ action: 'install', spec: 'package@1' }, parent)
    ).toBe(response === 1)
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      parent,
      expect.objectContaining({ cancelId: 0 })
    )
  })

  test('uses an application modal when the parent closes and propagates native failures', async () => {
    vi.mocked(app.getLocale).mockReturnValueOnce('zh-CN')
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(
      await confirmCoreDshPluginInstall(
        { action: 'update', spec: 'plugin@git+https://example.test/source' },
        { isDestroyed: () => true } as BrowserWindow
      )
    ).toBe(false)
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: '允许更新此 Core 插件吗？' })
    )
    vi.mocked(dialog.showMessageBox).mockRejectedValueOnce(new Error('Window failed'))
    await expect(
      confirmCoreDshPluginInstall({ action: 'install', spec: 'package' }, null)
    ).rejects.toThrow('Window failed')
  })
})
