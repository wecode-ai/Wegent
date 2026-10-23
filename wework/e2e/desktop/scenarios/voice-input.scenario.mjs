import assert from 'node:assert/strict'

export async function createDesktopScenario() {
  let restartDesktopApp
  return {
    setRestartDesktopApp(value) {
      restartDesktopApp = value
    },
    async verify(control) {
      // The isolated profile has no prepared speech model. No microphone or
      // model-service mock is needed to exercise the real first-use path.
      await control.command('waitFor', '[data-testid="new-chat-button"]')
      await control.command('click', '[data-testid="new-chat-button"]')
      const voice = '[data-testid="composer-voice-input"]'
      await control.command('waitFor', `${voice} button:not(:disabled)`)
      await control.command('click', `${voice} button`)
      const setup = '[role="dialog"] button[data-modal-autofocus]'
      await control.command('waitFor', setup)
      await control.command('click', setup)
      const dialog = '[data-testid="voice-input-setup"]'
      await control.command('waitFor', dialog)
      await control.command('waitFor', `${dialog} select`)
      await control.command('click', '[data-testid="voice-input-setup-close"]')
      assert.equal(Number(await control.command('getElementCount', dialog)), 0)
      await control.command('waitFor', `${voice} button`)
      // Startup reconciles the active bundle list. The official bundle must
      // survive that reconciliation, rather than disappear on the next launch.
      assert.equal(typeof restartDesktopApp, 'function')
      await restartDesktopApp()
      await control.command('waitFor', '[data-testid="new-chat-button"]')
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', `${voice} button:not(:disabled)`)
    },
  }
}
