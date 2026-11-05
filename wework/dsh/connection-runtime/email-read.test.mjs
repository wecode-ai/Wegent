import assert from 'node:assert/strict'
import test from 'node:test'
import { satisfies } from 'semver'
import { ConnectionRegistry } from '../plugin-runtime/connections.js'
import { createEmailAccounts } from './email-accounts.js'
import { createEmailProvider, EMAIL_PROVIDER } from './email-provider.js'

async function fixture({ count = 2, read = true } = {}) {
  const values = new Map()
  const calls = []
  const at = new Date(Date.now() - 60 * 1000)
  const client = {
    mailbox: { uidValidity: 123n, uidNext: 1000 },
    mailboxOpen: async (id, options) => calls.push(['open', id, options]),
    search: async (query, options) => {
      calls.push(['search', query, options])
      return Array.from({ length: count }, (_, index) => index + 1)
    },
    fetchAll: async (uids, query, options) => {
      calls.push(['fetch', uids, query, options])
      return uids.map(uid => ({ uid, internalDate: at, source: `mail-${uid}`, size: 20 }))
    },
  }
  const network = {
    imapSession: async (_account, action) => action(client),
    smtpTransport: async () => ({ verify: async () => {}, close() {} }),
    parseMail: async source => ({
      subject: source,
      from: { value: [{ name: 'Sender', address: 'sender@example.com' }] },
      text: 'Real source content from the IMAP protocol fixture',
    }),
  }
  const accounts = createEmailAccounts(
    {
      get: async key => values.get(key),
      set: async (key, value) => values.set(key, value),
    },
    network
  )
  const { id } = await accounts.save({
    email: 'owner@example.com',
    username: 'owner@example.com',
    password: 'TEST_ONLY_SECRET',
    imap: { host: 'imap.example.com', port: 993, secure: true },
    smtp: { host: 'smtp.example.com', port: 465, secure: true },
  })
  calls.length = 0
  const provider = createEmailProvider(accounts, network)
  if (!read) delete provider.readSource
  const registry = new ConnectionRegistry({
    inventory: async () => [],
    satisfies,
    context: value => value,
  })
  await registry.register({ effect() {} }, new URL('./package.json', import.meta.url), {
    email: {
      ...provider,
      executeAction: async () => {
        throw new Error('Read-only fixture')
      },
    },
  })
  const source = {
    providerId: EMAIL_PROVIDER,
    profile: id,
    kind: 'inbox',
    id: 'INBOX',
    name: 'Mailbox',
    boundary: { partition: '123', sequence: 999 },
  }
  return { registry, source, calls, client, at, accounts }
}

test('reads bounded historical mail without advancing the real intake boundary or exposing credentials', async () => {
  const f = await fixture()
  const boundary = structuredClone(f.source.boundary)
  const result = await f.registry.call(EMAIL_PROVIDER, 'readSource', { source: f.source })
  assert.deepEqual(
    result.items.map(item => item.id),
    ['123:2', '123:1']
  )
  assert.equal(result.items[0].subject, 'mail-2')
  assert.equal(result.items[0].from, 'sender@example.com')
  assert.ok(result.items[0].text.includes('IMAP protocol fixture'))
  assert.equal(result.readOnly, true)
  assert.equal(result.hasMore, false)
  assert.ok(Date.parse(result.range.since) <= f.at.getTime())
  assert.ok(Date.parse(result.range.until) >= f.at.getTime())
  assert.equal(JSON.stringify(result).includes('TEST_ONLY_SECRET'), false)
  assert.deepEqual(f.source.boundary, boundary)
  assert.deepEqual(f.calls[0], ['open', 'INBOX', { readOnly: true }])
  assert.equal(f.calls.filter(call => call[0] === 'search').length, 1)
  assert.equal(f.calls.find(call => call[0] === 'search')[1].uid, undefined)
  assert.deepEqual(f.calls.find(call => call[0] === 'fetch')[3], { uid: true })
})

test('returns at most twenty messages and marks unread remainder rather than pretending completeness', async () => {
  const f = await fixture({ count: 100 })
  const result = await f.registry.call(EMAIL_PROVIDER, 'readSource', {
    source: f.source,
    limit: 20,
  })
  assert.equal(result.items.length, 20)
  assert.equal(result.hasMore, true)
  const fetch = f.calls.find(call => call[0] === 'fetch')
  assert.equal(fetch[1].length, 21)
  assert.equal(fetch[1][0], 100)
  assert.equal(fetch[2].source.maxLength, 262144)
})

test('rejects invalid windows and bounds before making any IMAP request', async () => {
  const f = await fixture()
  for (const options of [
    { limit: 0 },
    { limit: 21 },
    { limit: 1.5 },
    { since: 123 },
    { since: 'invalid' },
    { since: '2000-01-01T00:00:00Z' },
    { since: '2099-01-01T00:00:00Z' },
  ]) {
    await assert.rejects(
      f.registry.call(EMAIL_PROVIDER, 'readSource', { source: f.source, ...options }),
      {
        code: 'email_read_range_invalid',
      }
    )
  }
  assert.equal(f.calls.length, 0)
})

test('filters the precise timestamp even when IMAP date search includes the start of the day', async () => {
  const f = await fixture()
  const since = new Date(Date.now() - 2 * 60 * 1000)
  f.client.fetchAll = async () => [
    { uid: 1, internalDate: new Date(since.getTime() - 1000), source: 'old', size: 20 },
    { uid: 2, internalDate: f.at, source: 'new', size: 20 },
  ]
  const result = await f.registry.call(EMAIL_PROVIDER, 'readSource', {
    source: f.source,
    since: since.toISOString(),
  })
  assert.deepEqual(
    result.items.map(item => item.id),
    ['123:2']
  )
})

test('missing accounts and transport failures stay failures rather than successful empty mailboxes', async () => {
  const f = await fixture()
  await assert.rejects(
    f.registry.call(EMAIL_PROVIDER, 'readSource', {
      source: { ...f.source, profile: 'unconnected' },
    }),
    { code: 'email_account_missing' }
  )
  f.client.search = async () => {
    throw Object.assign(new Error('transport failed'), { code: 'email_transport_failed' })
  }
  await assert.rejects(f.registry.call(EMAIL_PROVIDER, 'readSource', { source: f.source }), {
    code: 'email_transport_failed',
  })
})

test('optional reads do not make older providers invalid or bypass exact source validation', async () => {
  const unsupported = await fixture({ read: false })
  await assert.rejects(
    unsupported.registry.call(EMAIL_PROVIDER, 'readSource', { source: unsupported.source }),
    {
      code: 'source_read_unsupported',
    }
  )
  const f = await fixture()
  for (const patch of [{ providerId: 'other' }, { id: '*' }, { scope: 'all' }, { kind: 'other' }]) {
    await assert.rejects(
      f.registry.call(EMAIL_PROVIDER, 'readSource', { source: { ...f.source, ...patch } }),
      error => ['invalid_connection', 'email_invalid_configuration'].includes(error.code)
    )
  }
  assert.equal(f.calls.length, 0)
})
