import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function createDesktopScenario({ resultDir, workbenchReadyTimeoutMs }) {
  return {
    appEnvironment: { WEWORK_E2E_STARTUP_NETWORK_CHANGE: '1' },
    async verify(control) {
      await control.command('waitFor', '[data-testid="new-chat-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const log = await readFile(join(resultDir, 'app.log'), 'utf8')
      assert.equal(log.split('[startup-network-fault] injected').length - 1, 1)
      assert.equal(log.split('[startup-network-recovery]').length - 1, 1)
      assert.ok(log.includes('net::ERR_NETWORK_CHANGED'))
      assert.ok(
        log.indexOf('[startup-network-recovery]') < log.indexOf("step: 'renderer-startup-ready'")
      )
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', '[data-testid="chat-message-input"]', { visible: true })
    },
  }
}
