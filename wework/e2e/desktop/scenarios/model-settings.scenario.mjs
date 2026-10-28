import assert from 'node:assert/strict'
import { verifyCredentialSecurity } from '../modules/credential-security-flow.mjs'
import {
  activateCredentialRecoveryFixture,
  seedCredentialRecovery,
  verifyCredentialRecovery,
} from '../modules/credential-recovery-flow.mjs'

const selector = id => `[data-testid="${id}"]`

export async function createDesktopScenario({ captureScreenshot, electronUserDataDirectory }) {
  await seedCredentialRecovery(electronUserDataDirectory)
  return {
    async verify(control) {
      await activateCredentialRecoveryFixture(control)
      await verifyCredentialSecurity(control, electronUserDataDirectory)
      await verifyCredentialRecovery(control)
      await control.command('navigate', 'body', { value: '/settings/connections' })
      await control.command('waitFor', selector('settings-cloud-disconnect-button'))
      await control.command('click', selector('settings-cloud-disconnect-button'))
      await control.command('waitFor', selector('settings-cloud-disconnect-button'), {
        visible: false,
      })
      await control.command('navigate', 'body', { value: '/settings/personal/models' })
      await control.command('waitFor', selector('provider-add'), { text: '添加模型' })
      const page = JSON.parse(await control.command('snapshot', selector('model-settings-page')))
      assert.ok(page.text.includes('自定义模型'))
      assert.ok(!page.text.includes('Provider'))
      assert.ok(!page.testIds.includes('reply-prediction-settings'))
      assert.ok(!page.testIds.includes('local-model-add-button'))
      assert.ok(!page.testIds.includes('runtime-config-error'))
      await captureScreenshot(control, 'model-settings-01-page.png', 'body')

      await control.command('click', selector('provider-add'))
      await control.command('waitFor', selector('provider-editor'))
      await control.command('select', selector('provider-preset'), { value: 'deepseek' })
      assert.equal(
        Number(await control.command('getElementCount', selector('provider-base-url'))),
        0
      )
      assert.equal(
        Number(await control.command('getElementCount', selector('provider-protocol'))),
        0
      )
      assert.equal(
        Number(
          await control.command('getElementCount', `${selector('provider-discover')}:disabled`)
        ),
        1
      )
      await captureScreenshot(control, 'model-settings-02-deepseek-key-only.png', 'body')

      await control.command('select', selector('provider-preset'), { value: 'custom' })
      await control.command('fill', selector('provider-name'), { value: '设置验证接口' })
      await control.command('fill', selector('provider-base-url'), {
        value: 'https://model-settings.example/v1',
      })
      await control.command('click', selector('provider-model-add'))
      const editor = JSON.parse(await control.command('snapshot', selector('provider-editor')))
      const modelInput = editor.testIds.find(id => id.startsWith('provider-model-id-'))
      assert.ok(modelInput, 'Manual model editor was not opened')
      const modelId = modelInput.slice('provider-model-id-'.length)
      await control.command('fill', selector(modelInput), { value: 'settings-verification-model' })
      await control.command('fill', selector('local-model-context-window-input'), {
        value: '128000',
      })
      await captureScreenshot(control, 'model-settings-03-custom-model-settings.png', 'body')
      await control.command('click', selector('provider-editor-save'))
      await control.command('waitFor', selector('provider-settings-section'), {
        text: '设置验证接口',
      })
      assert.equal(Number(await control.command('getElementCount', selector('provider-editor'))), 0)

      const row = `[data-testid^="provider-row-"]:has(${selector(`provider-model-${modelId}`)})`
      await control.command('click', `${row} > summary`)
      await control.command('waitFor', selector(`provider-model-edit-${modelId}`))
      await captureScreenshot(control, 'model-settings-04-added.png', 'body')
      await control.command('click', selector(`provider-model-edit-${modelId}`))
      await control.command('waitFor', selector('local-model-context-window-input'))
      assert.equal(
        await control.command('getValue', selector('local-model-context-window-input')),
        '128000'
      )
      await control.command('click', selector('provider-editor-cancel'))
      await control.command('click', `${row} [data-testid^="provider-delete-"]`)
      await control.command('waitFor', selector('provider-action-confirm'))
      await control.command('click', selector('provider-action-confirm'))
      await control.command('waitFor', `${selector('provider-add')}:not([disabled])`)
      await control.command('waitFor', selector(`provider-model-${modelId}`), { visible: false })
      assert.equal(
        Number(await control.command('getElementCount', selector(`provider-model-${modelId}`))),
        0
      )

      await control.command('navigate', 'body', { value: '/settings/general' })
      await control.command('waitFor', selector('reply-prediction-settings'))
      await control.command('scrollIntoView', selector('reply-prediction-settings'))
      await captureScreenshot(control, 'model-settings-05-general-reply-settings.png', 'body')
    },
  }
}
