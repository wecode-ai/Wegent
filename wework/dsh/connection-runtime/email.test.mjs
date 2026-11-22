import assert from 'node:assert/strict'
import test from 'node:test'
import { constants as osConstants } from 'node:os'
import { ConnectionRegistry } from '../plugin-runtime/connections.js'
import { createEmailAccounts } from './email-accounts.js'
import { createEmailProvider, EMAIL_PROVIDER } from './email-provider.js'
import { initializeObservation } from '../plugin-runtime/connection-observations.js'
import { createEmailSender } from './email-send.js'
import { imapError, mailError } from './email-client.js'

test('distinguishes recoverable IMAP transport from authentication, TLS and message errors', () => {
  const networkCodes = Object.keys(osConstants.errno).filter(code =>
    /^(ECONN|ENET|EHOST)/.test(code)
  )
  assert.ok(networkCodes.length > 0)
  for (const code of networkCodes)
    assert.equal(
      imapError({ code }).code,
      'email_transport_failed',
      `Recover the platform network error ${code}`
    )
  for (const code of [
    'ECONNRESET',
    'NoConnection',
    'ClosedAfterConnectTLS',
    'ETIMEOUT',
    'ENOTFOUND',
    'EHOSTDOWN',
  ])
    assert.equal(
      imapError({ code, message: 'private server details' }).code,
      'email_transport_failed'
    )
  assert.equal(
    imapError({ authenticationFailed: true, code: 'ECONNRESET' }).code,
    'email_auth_failed'
  )
  for (const error of [
    { code: 'CERT_HAS_EXPIRED' },
    { code: 42 },
    new Error('private account details'),
  ])
    assert.equal(imapError(error).code, 'email_connection_failed')
  const invalid = mailError('email_message_invalid')
  assert.equal(imapError(invalid), invalid)
  assert.equal(imapError(new Error('private account details')).message, 'email_connection_failed')
  assert.equal(imapError({ code: 'ECONNRESET' }).retryAfterMs, 30000)
  assert.equal(
    imapError({ authenticationFailed: true, code: 'ECONNRESET' }).retryAfterMs,
    undefined
  )
  assert.equal(imapError({ code: 'CERT_HAS_EXPIRED' }).retryAfterMs, undefined)
  assert.equal(imapError(invalid).retryAfterMs, undefined)
})

function storage() {
  const values = new Map()
  return {
    get: async key => values.get(key),
    set: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
    values,
  }
}
const config = {
  email: 'owner@example.com',
  username: 'owner@example.com',
  password: 'test-only',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true },
}
function setup() {
  const secret = storage()
  const network = {
    imapSession: async (_account, action) => action({ mailboxOpen: async () => {} }),
    smtpTransport: async () => ({ verify: async () => {}, close() {} }),
  }
  const accounts = createEmailAccounts(secret, network)
  return { secret, network, accounts }
}

test('validates both protocols, redacts credentials, and preserves the account identity on update', async () => {
  const f = setup()
  const { id } = await f.accounts.save(config)
  assert.equal((await f.accounts.list())[0].password, undefined)
  assert.equal((await f.accounts.get(id)).password, config.password)
  const updated = await f.accounts.save({ ...config, password: 'updated-test-only' })
  assert.equal(updated.id, id)
  assert.equal((await f.accounts.list()).length, 1)
  f.network.smtpTransport = async () => ({
    verify: async () => {
      throw new Error('private response')
    },
    close() {},
  })
  await assert.rejects(f.accounts.save({ ...config, password: 'bad' }), {
    code: 'email_smtp_failed',
  })
  assert.equal((await f.accounts.get(id)).password, 'updated-test-only')
  await f.accounts.remove({ id })
  await assert.rejects(f.accounts.get(id), { code: 'email_account_missing' })
  await assert.rejects(f.accounts.save({ ...config, id }), { code: 'email_account_missing' })
})

test('account deletion waits for an already started operation and blocks later operations', async () => {
  const f = setup()
  const { id } = await f.accounts.save(config)
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const operation = f.accounts.use(id, async () => {
    await gate
    return 'sent'
  })
  const removal = f.accounts.remove({ id })
  release()
  assert.equal(await operation, 'sent')
  await removal
  await assert.rejects(
    f.accounts.use(id, () => 'must not send'),
    { code: 'email_account_missing' }
  )
})

test('UID snapshots separate old and new mail even with identical server timestamps and detect mailbox resets', async () => {
  const after = '2026-11-04T00:00:00.000Z'
  const queries = []
  const client = {
    mailbox: { uidValidity: 123n, uidNext: 2 },
    mailboxOpen: async () => {},
    search: async query => {
      queries.push(query)
      return [2, 3]
    },
    fetchAll: async () => [
      { uid: 2, internalDate: new Date(after), source: 'new', size: 10 },
      { uid: 3, internalDate: new Date(after), source: 'new', size: 10 },
    ],
  }
  const provider = createEmailProvider(
    { get: async () => config, list: async () => [{ id: 'one', email: config.email }] },
    {
      imapSession: async (_account, action) => action(client),
      parseMail: async () => ({
        subject: 'Hello',
        text: 'Work',
        from: { value: [{ address: 'sender@example.com' }] },
      }),
    }
  )
  const ctx = { signal: new AbortController().signal }
  const discovered = await provider.listResources(ctx, { kind: 'inbox', query: '' })
  const { source, checkpoint } = await initializeObservation(
    { call: (_id, method, input) => provider[method](ctx, input) },
    EMAIL_PROVIDER,
    { ...discovered.items[0], enabledAfter: after }
  )
  assert.deepEqual(source.boundary, { partition: '123', sequence: 1 })
  assert.deepEqual(checkpoint, {
    partition: '123',
    sequence: 1,
    activationBoundary: { partition: '123', sequence: 1 },
  })
  client.mailbox.uidNext = 4
  const page = await provider.collect(ctx, { source, checkpoint })
  assert.deepEqual(
    page.events.map(event => event.id),
    ['123:2', '123:3']
  )
  assert.deepEqual(queries[0], { uid: '2:3' })
  assert.equal(page.nextCheckpoint.sequence, 3)
  assert.equal(page.hasMore, false)
  const next = await initializeObservation(
    { call: (_id, method, input) => provider[method](ctx, input) },
    EMAIL_PROVIDER,
    source
  )
  assert.deepEqual(next.source.boundary, { partition: '123', sequence: 3 })
  assert.deepEqual(
    (await provider.collect(ctx, next)).events,
    [],
    'A new subscription excludes mail between the old and fresh boundaries'
  )
  client.mailbox.uidNext = 5
  client.search = async () => [4]
  client.fetchAll = async () => [{ uid: 4, internalDate: new Date(after), source: 'new', size: 10 }]
  assert.deepEqual(
    (await provider.collect(ctx, next)).events.map(event => event.id),
    ['123:4']
  )
  client.mailbox.uidValidity = 456n
  await assert.rejects(provider.collect(ctx, { source, checkpoint }), {
    code: 'email_mailbox_reset',
  })
  assert.equal(checkpoint.sequence, 1)
})

test('confirmed email is sent once; unknown delivery stays blocked and definite pre-DATA failures can recover', async () => {
  const f = setup()
  const { id } = await f.accounts.save(config)
  const outbox = storage()
  let deliveries = 0
  let sentId
  let failure
  const sendEmail = createEmailSender(f.accounts, outbox, {
    imapSession: async (_account, action) =>
      action({
        mailboxOpen: async () => {},
        mailbox: { uidValidity: 123n },
        fetchOne: async () => ({
          envelope: {
            from: [{ address: 'sender@example.com' }],
            messageId: '<original@example.com>',
          },
        }),
      }),
    smtpTransport: async () => ({
      verify: async () => {},
      close() {},
      sendMail: async mail => {
        deliveries++
        sentId = mail.messageId
        assert.equal(mail.inReplyTo, '<original@example.com>')
        if (failure) throw failure
        return { accepted: ['sender@example.com'], rejected: [] }
      },
    }),
  })
  const registry = new ConnectionRegistry({ context: value => value })
  await registry.register({ effect() {} }, new URL('./package.json', import.meta.url), {
    email: {
      ...createEmailProvider(f.accounts),
      executeAction: (_context, input) => sendEmail(input),
    },
  })
  const sender = input =>
    registry.call(EMAIL_PROVIDER, 'executeAction', { ...input, action: 'send_email' })
  const input = {
    source: {
      providerId: EMAIL_PROVIDER,
      id: 'INBOX',
      kind: 'inbox',
      profile: id,
      policy: { askBeforeAct: true },
    },
    messageId: '123:2',
    workId: 'work',
    from: config.email,
    to: 'sender@example.com',
    subject: 'Re: Hello',
    text: 'Confirmed reply',
  }
  await assert.rejects(
    sender({ ...input, source: { ...input.source, policy: { askBeforeAct: false } } }),
    { code: 'email_confirmation_required' }
  )
  assert.equal(deliveries, 0)
  const receipt = await sender(input)
  assert.match(sentId, /^<[0-9a-f]{64}@wework\.local>$/)
  assert.deepEqual(receipt, {
    status: 'sent',
    messageId: sentId,
    inReplyTo: '<original@example.com>',
  })
  assert.deepEqual(await sender(input), { status: 'sent', messageId: sentId, duplicate: true })
  assert.equal(deliveries, 1)
  failure = Object.assign(new Error('private'), { command: 'DATA' })
  const unknown = { ...input, text: 'Unknown delivery' }
  await assert.rejects(sender(unknown), { code: 'email_send_unknown' })
  await assert.rejects(sender(unknown), { code: 'email_send_unknown' })
  assert.equal(deliveries, 2)
  failure = Object.assign(new Error('private'), { command: 'AUTH' })
  const recoverable = { ...input, text: 'Recoverable failure' }
  await assert.rejects(sender(recoverable), { code: 'email_smtp_failed' })
  failure = undefined
  await sender(recoverable)
  assert.equal(deliveries, 4)
  await f.accounts.remove({ id })
  await assert.rejects(sender({ ...input, text: 'Revoked account' }), {
    code: 'email_account_missing',
  })
  assert.equal(deliveries, 4)
})

async function continuousReplyFixture() {
  const f = setup()
  const { id } = await f.accounts.save(config)
  const deliveries = []
  const reads = []
  const sender = createEmailSender(f.accounts, storage(), {
    imapSession: async (_account, action) =>
      action({
        mailboxOpen: async () => {},
        mailbox: { uidValidity: 123n },
        fetchOne: async uid => {
          reads.push(uid)
          return {
            envelope: {
              from: [{ address: 'original-sender@example.com' }],
              messageId: '<bound-message@example.com>',
            },
          }
        },
      }),
    smtpTransport: async () => ({
      verify: async () => {},
      close() {},
      sendMail: async mail => {
        deliveries.push(mail)
        return { accepted: [mail.to], rejected: [] }
      },
    }),
  })
  const input = {
    source: { id: 'INBOX', kind: 'inbox', profile: id, policy: { askBeforeAct: false } },
    authorization: 'continuous_reply',
    reply: true,
    messageId: '123:7',
    workId: 'continuous-reply-work',
    from: config.email,
    to: 'original-sender@example.com',
    subject: 'Re: Existing conversation',
    text: 'Reply within the confirmed source scope',
  }
  return { sender, input, deliveries, reads }
}

test('continuous source authorization replies only inside the verified original mail thread', async () => {
  const { sender, input, deliveries, reads } = await continuousReplyFixture()
  const receipt = await sender(input)
  assert.deepEqual(reads, [7])
  assert.deepEqual(receipt, {
    status: 'sent',
    messageId: deliveries[0].messageId,
    inReplyTo: '<bound-message@example.com>',
  })
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].from, config.email)
  assert.equal(deliveries[0].to, 'original-sender@example.com')
  assert.equal(deliveries[0].inReplyTo, '<bound-message@example.com>')
  assert.equal(deliveries[0].references, '<bound-message@example.com>')
})

test('continuous reply authorization does not authorize a new outgoing email', async () => {
  const { sender, input, deliveries, reads } = await continuousReplyFixture()
  await assert.rejects(sender({ ...input, reply: false }), { code: 'email_confirmation_required' })
  assert.equal(deliveries.length, 0)
  assert.equal(reads.length, 0)
})

test('continuous authorization cannot replace the original email sender with a new recipient', async () => {
  const { sender, input, deliveries, reads } = await continuousReplyFixture()
  await assert.rejects(sender({ ...input, to: 'another-person@example.com' }), {
    code: 'email_reply_recipient_changed',
  })
  assert.deepEqual(reads, [7])
  assert.equal(deliveries.length, 0)
})

test('revoking continuous source authorization blocks an in-flight automatic reply', async () => {
  const { sender, input, deliveries } = await continuousReplyFixture()
  await assert.rejects(
    sender({ ...input, source: { ...input.source, policy: { askBeforeAct: true } } }),
    { code: 'email_confirmation_required' }
  )
  assert.equal(deliveries.length, 0)
})
