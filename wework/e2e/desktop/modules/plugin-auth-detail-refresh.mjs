import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForWindowState } from './native-window-state.mjs'

export async function verifyPluginAuthDetailRefresh({
  control,
  slug,
  homePath,
  captureScreenshot,
  waitForValue,
  uiTimeoutMs,
}) {
  const approval = join(homePath, 'conversation-qr-approved')
  const failure = join(homePath, 'conversation-qr-health-fail')
  const manage = '[data-testid="plugin-connection-manage-connector:conversation-qr"]'
  const auth = async action =>
    JSON.parse(
      await control.command('localConnectorAuth', 'body', {
        value: JSON.stringify({ pluginKey: slug, connectorSlug: 'conversation-qr', action }),
      })
    )
  try {
    for (const mode of ['focus', 'auth-change']) {
      await writeFile(approval, 'approved')
      assert.equal((await auth('start')).status, 'ok')
      await control.command('waitFor', manage, { text: '退出登录' })
      await writeFile(failure, 'error')
      // The real uncached probe invalidates the cached success before refreshing.
      assert.equal((await auth('health')).status, 'error')
      if (mode === 'focus') {
        await control.command('closeMainWindowToTray', 'body')
        await waitForWindowState(
          control,
          state => !state.visible,
          'Main window did not hide',
          10_000
        )
        await control.command('restoreMainWindow', 'body')
        await waitForWindowState(
          control,
          state => state.visible,
          'Main window did not return',
          10_000
        )
      } else {
        await writeFile(failure, 'throw')
        await assert.rejects(() => auth('health'))
        // A successful real poll emits the same auth-change event as login completion.
        assert.equal((await auth('poll')).status, 'ok')
      }
      await control.command('waitFor', '[data-testid="plugin-detail-action-error"]')
      if (mode === 'focus') {
        await control.command('closeMainWindowToTray', 'body')
        await waitForWindowState(
          control,
          state => !state.visible,
          'Focus verification did not return the isolated window to the background',
          10_000
        )
      }
      assert.equal((await control.command('getText', manage)).trim(), '退出登录')
      await captureScreenshot(control, `plugin-auth-detail-${mode}-health-failure.png`, 'body')

      assert.equal((await auth('logout')).status, 'ok')
      await assert.rejects(readFile(approval), { code: 'ENOENT' })
      await rm(failure)
      // Repeated logout emits a fresh event after the real provider recovers.
      assert.equal((await auth('logout')).status, 'ok')
      // Substring matching also accepts the previous label "退出登录".
      await waitForValue(
        () => control.command('getText', manage),
        text => text.trim() === '登录',
        uiTimeoutMs,
        'Connector did not return to the logged-out state'
      )
      assert.equal((await control.command('getText', manage)).trim(), '登录')
      await control.command('waitFor', '[data-testid="plugin-detail-action-error"]', {
        visible: false,
      })
      console.log(
        `[desktop-e2e-account] detail auth refresh ${mode}: state, logout and recovery passed`
      )
    }
  } finally {
    await rm(failure, { force: true })
    await rm(approval, { force: true })
  }
}
