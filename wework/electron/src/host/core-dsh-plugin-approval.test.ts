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
  test.each(['\u061c', '\u200e', '\u200f', '\u202e', '\u2067'])(
    'escapes source direction controls without changing the installation request (%s)',
    mark => {
      const request = { action: 'install' as const, spec: `plugin${mark}tgz` }
      const options = coreDshPluginInstallDialog(request, copy('en'))
      expect(options.detail).toContain(
        `plugin\\u${mark.charCodeAt(0).toString(16).padStart(4, '0')}tgz`
      )
      expect(options.detail).not.toContain(mark)
      expect(request.spec).toBe(`plugin${mark}tgz`)
    }
  )
  test.each(['en', 'zh-CN'])('names the update consent scope in %s', language => {
    const translations = copy(language)
    const options = coreDshPluginInstallDialog(
      { action: 'update', spec: 'package@next' },
      translations
    )
    expect(options.title).toBe(translations.core_dsh_plugins_native_update_title)
    expect(options.detail).toContain(translations.core_dsh_plugins_update_confirm_description)
    expect(options.detail).not.toContain(translations.core_dsh_plugins_install_confirm_description)
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
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response, checkboxChecked: false })
      const parent = { isDestroyed: () => false } as BrowserWindow
      expect(
        await confirmCoreDshPluginInstall({ action: 'install', spec: 'package@1' }, parent)
      ).toBe(response === 1)
      expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
        parent,
        expect.objectContaining({ cancelId: 0 })
      )
      expect(log).toHaveBeenCalledWith('[Wework] Core plugin native decision', {
        action: 'install',
        response,
      })
    } finally {
      log.mockRestore()
    }
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
