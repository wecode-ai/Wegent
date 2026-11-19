import assert from 'node:assert/strict'

const COMPOSER_SELECTOR =
  '[data-testid="desktop-empty-composer-frame"] [data-testid="chat-message-input"]'

async function waitForPressed(control, selector, expected) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if ((await control.command('getAttribute', selector, { value: 'aria-pressed' })) === expected) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${selector} did not reach aria-pressed=${expected}`)
}

export async function createDesktopScenario() {
  return {
    async verify(control) {
      const enterButton = '[data-testid="general-send-key-enter-button"]'
      const commandEnterButton = '[data-testid="general-send-key-cmd_enter-button"]'

      await control.command('navigate', 'body', { value: '/settings/general' })
      await control.command('waitFor', commandEnterButton)
      await control.command('clickWhenEnabled', commandEnterButton)
      await waitForPressed(control, commandEnterButton, 'true')

      await control.command('navigate', 'body', { value: '/' })
      await control.command('waitFor', COMPOSER_SELECTOR)
      await control.command('fill', COMPOSER_SELECTOR, { value: 'first line' })
      const messageCountBeforeEnter = Number(
        await control.command('getElementCount', '[data-testid="message-user"]')
      )
      await control.command('nativePress', COMPOSER_SELECTOR, { key: 'Enter' })

      assert.equal(
        await control.command('getValue', COMPOSER_SELECTOR),
        'first line\n',
        'Enter did not insert a line break while Command-Enter send mode was selected'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="message-user"]')),
        messageCountBeforeEnter,
        'Enter unexpectedly sent the composer while Command-Enter send mode was selected'
      )

      await control.command('navigate', 'body', { value: '/settings/general' })
      await control.command('waitFor', commandEnterButton)
      await waitForPressed(control, commandEnterButton, 'true')
      await control.command('clickWhenEnabled', enterButton)
      await waitForPressed(control, enterButton, 'true')
    },

    diagnostics() {
      return { sendKeyPreference: true }
    },
  }
}
