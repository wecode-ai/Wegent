import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ACTIVE_COMPOSER_SELECTOR } from './shared.mjs'
import { testId } from './plugin-regression-fixture.mjs'

export async function verifyConversationQrAuthorization({
  control,
  slug,
  qrPrompt,
  ordinaryPrompt,
  qrRequests,
  getOrdinaryRequests,
  qrApproval,
  captureScreenshot,
  homePath,
}) {
  // Use the real installed membership, manifest reader, packaged auth CLI,
  // and native QR session. Only the model response is controlled here.
  for (const action of ['cancel', 'ordinary', 'preflight', 'resume']) {
    const mode = action === 'resume' ? 'resume' : 'preflight'
    await control.command('localConnectorAuth', 'body', {
      value: JSON.stringify({
        pluginKey: slug,
        connectorSlug: 'conversation-qr',
        action: 'logout',
      }),
    })
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: `${qrPrompt} ${mode}` })
    if (mode === 'preflight') {
      await control.command('click', '[data-testid="composer-plugin-picker-button"]')
      await control.command('fill', '[data-testid="composer-plugin-picker-search"]', {
        value: slug,
      })
      await control.command('click', `[data-testid="composer-plugin-picker-item-plugin:${slug}"]`)
      // getValue returns display labels, not serialized references. Preserve
      // the real picker chip instead of filling its plain-text label back in.
      await control.command('waitFor', testId('composer-plugin-chip-' + slug))
    }
    const pendingDraft = await control.command('getValue', ACTIVE_COMPOSER_SELECTOR)
    await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', '[data-testid="connector-auth-qr"]')
    if (mode === 'preflight') {
      const emptyDock = JSON.parse(
        await control.command('snapshot', '[data-testid="desktop-empty-composer-dock"]')
      )
      assert.ok(
        emptyDock.testIds.includes('connector-auth-card'),
        'New conversation did not mount its authorization card'
      )
    }
    assert.equal(
      qrRequests[mode],
      mode === 'preflight' ? 0 : 1,
      'Conversation continued before QR authorization'
    )
    await captureScreenshot(control, `plugin-auth-conversation-${mode}-qr.png`, 'body')
    if (action === 'cancel' || action === 'ordinary') {
      if (action === 'cancel') {
        await control.command('click', '[data-testid="connector-auth-cancel"]')
        assert.equal(
          await control.command('getValue', ACTIVE_COMPOSER_SELECTOR),
          pendingDraft,
          'Cancelling login discarded the unsent draft'
        )
      }
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: ordinaryPrompt })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', 'body', { text: `${ordinaryPrompt} completed` })
      assert.equal(getOrdinaryRequests(), action === 'cancel' ? 1 : 2)
      assert.equal(qrRequests.preflight, 0, 'Discarded plugin draft was sent')
      const recovered = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(!recovered.testIds.includes('connector-auth-card'))
      continue
    }
    await writeFile(qrApproval, 'approved')
    await control.command('waitFor', 'body', { text: `${qrPrompt} ${mode} completed` })
    assert.equal(
      qrRequests[mode],
      mode === 'preflight' ? 1 : 2,
      'QR completion did not resume the conversation exactly once'
    )
    const authorized = JSON.parse(await control.command('snapshot', 'body'))
    assert.ok(!authorized.testIds.includes('connector-auth-card'), 'QR card remained after login')
  }
  await control.command('localConnectorAuth', 'body', {
    value: JSON.stringify({
      pluginKey: slug,
      connectorSlug: 'conversation-qr',
      action: 'logout',
    }),
  })

  const failurePath = join(homePath, 'conversation-qr-fail')
  const baseline = { ...qrRequests }
  const sendOrdinary = async () => {
    const before = getOrdinaryRequests()
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: ordinaryPrompt })
    await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', 'body', {
      text: ordinaryPrompt + ' completed',
      // Observe beyond the real provider's one-second polling interval.
      stableMs: 1500,
    })
    assert.equal(getOrdinaryRequests(), before + 1, 'Ordinary chat was blocked or sent twice')
    assert.deepEqual(qrRequests, baseline, 'A cancelled draft resumed in another conversation')
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.ok(!snapshot.testIds.includes('connector-auth-card'), 'Stale login card blocks chat')
  }
  const beginPreflight = async () => {
    await control.command('click', testId('new-chat-button'))
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: qrPrompt })
    await control.command('click', testId('composer-plugin-picker-button'))
    await control.command('fill', testId('composer-plugin-picker-search'), { value: slug })
    await control.command('click', testId('composer-plugin-picker-item-plugin:' + slug))
    await control.command('waitFor', testId('composer-plugin-chip-' + slug))
    const draft = await control.command('getValue', ACTIVE_COMPOSER_SELECTOR)
    await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
    return draft
  }
  try {
    // Fail inside the actual packaged provider, not by replacing IPC or fetch.
    await writeFile(failurePath, 'fail')
    const draft = await beginPreflight()
    await control.command('waitFor', testId('connector-auth-error'), {
      text: 'E2E_QR_START_FAILED',
    })
    assert.deepEqual(qrRequests, baseline, 'Failed authorization sent the pending draft')
    await rm(failurePath)
    await control.command('clickWhenEnabled', testId('connector-auth-retry'))
    await control.command('waitFor', testId('connector-auth-qr'))
    await control.command('click', testId('connector-auth-cancel'))
    assert.equal(await control.command('getValue', ACTIVE_COMPOSER_SELECTOR), draft)
    await sendOrdinary()
    // Navigating away must dispose the pending session. Late provider success
    // must not submit the old draft or attach its card to the new conversation.
    await beginPreflight()
    await control.command('waitFor', testId('connector-auth-qr'))
    await control.command('click', testId('new-chat-button'))
    await writeFile(qrApproval, 'approved')
    await sendOrdinary()
    await captureScreenshot(control, 'plugin-auth-failure-navigation-recovery.png', 'body')
  } finally {
    await rm(failurePath, { force: true })
    await control.command('localConnectorAuth', 'body', {
      value: JSON.stringify({
        pluginKey: slug,
        connectorSlug: 'conversation-qr',
        action: 'logout',
      }),
    })
  }
}
