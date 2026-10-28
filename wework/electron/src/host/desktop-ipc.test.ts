import { expect, test } from 'vitest'
import { assertDesktopIpcSender } from './desktop-ipc.js'
import { publicCredentialKey } from './public-credential-key.js'

test('only the live registered main frame at its exact origin can invoke host services', () => {
  const frame = { url: 'http://127.0.0.1:32100/wework/#/settings' }
  const sender = { id: 7, isDestroyed: () => false, mainFrame: frame }
  const origins = new Map([[7, 'http://127.0.0.1:32100/wework/']])
  expect(() => assertDesktopIpcSender({ sender, senderFrame: frame }, origins)).not.toThrow()
  for (const event of [
    { sender: { ...sender, id: 8 }, senderFrame: frame },
    { sender: { ...sender, isDestroyed: () => true }, senderFrame: frame },
    { sender, senderFrame: null },
    { sender, senderFrame: { ...frame } },
  ])
    expect(() => assertDesktopIpcSender(event, origins)).toThrow(/trusted application window/)
  for (const url of [
    'http://attacker.test:32100/wework/',
    'http://127.0.0.1:32101/',
    'https://127.0.0.1:32100/',
    'file:///app.html',
    'http://user:password@127.0.0.1:32100/',
    'data:text/html,hello',
    'invalid',
  ]) {
    const mainFrame = { url }
    expect(() =>
      assertDesktopIpcSender({ sender: { ...sender, mainFrame }, senderFrame: mainFrame }, origins)
    ).toThrow()
  }
})

test.each(['get', 'set', 'delete'])(
  'generic secureStorage.%s cannot reach any business credential',
  () => {
    for (const key of [
      'wework-model-key.valid-key',
      'wework-models.last-good',
      'wework-models.pending',
      'wework-cloud.identity',
      'wework-cloud.legacy',
      'wework-cloud.migrated',
    ]) {
      expect(() => publicCredentialKey({ key })).toThrow(/private/)
    }
    expect(publicCredentialKey({ key: 'plugin-own.valid-key' })).toBe('plugin-own.valid-key')
  }
)
