import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function createDesktopScenario({ resultDir, uiTimeoutMs }) {
  const codexHome = join(resultDir, 'codex-account-login-home')
  await mkdir(codexHome, { recursive: true })

  return {
    appEnvironment: {
      CODEX_HOME: codexHome,
      WEGENT_CODEX_HOME: codexHome,
    },

    async verify(control) {
      const telemetryConsent = '[data-testid="telemetry-consent-decline"]'
      if (Number(await control.command('getElementCount', telemetryConsent)) > 0) {
        await control.command('click', telemetryConsent)
      }

      await control.command('navigate', 'body', { value: '/settings/personal/models' })
      await control.command('waitFor', '[data-testid="local-codex-login-button"]', {
        text: '登录',
        timeoutMs: uiTimeoutMs,
      })

      const snapshot = JSON.parse(
        await control.command('snapshot', '[data-testid="local-codex-model-row"]')
      )
      assert.ok(snapshot.text.includes('Codex 账号'), 'Codex account title was not shown')
      assert.ok(snapshot.text.includes('未登录'), 'Signed-out account state was not shown')
      assert.ok(
        snapshot.text.includes('登录 ChatGPT 账号以在 Wework 中使用 Codex。'),
        'Codex sign-in value proposition was not shown'
      )
      assert.ok(!snapshot.text.includes('auth.json'), 'Internal auth path leaked into account UI')
      assert.ok(!snapshot.text.includes('SHA-256'), 'Internal auth digest leaked into account UI')
    },

    diagnostics() {
      return { codexAccountLogin: true }
    },
  }
}
