import { randomUUID } from 'node:crypto'
import { imapSession, smtpTransport, mailError } from './email-client.js'

export function createEmailAccounts(storage, network = { imapSession, smtpTransport }) {
  let pending = Promise.resolve()
  const read = async () => JSON.parse((await storage.get('accounts')) || '{}')
  const mutate = action => {
    const result = pending.then(async () => {
      const accounts = await read()
      const value = await action(accounts)
      await storage.set('accounts', JSON.stringify(accounts))
      return value
    })
    pending = result.catch(() => {})
    return result
  }
  const get = async id => {
    const accounts = await read()
    const account = Object.hasOwn(accounts, id) ? accounts[id] : null
    if (!account) throw mailError('email_account_missing')
    return account
  }
  return {
    get,
    use(id, action) {
      const result = pending.then(async () => action(await get(id)))
      pending = result.catch(() => {})
      return result
    },
    async list() {
      return Object.values(await read()).map(({ password: _password, ...account }) => account)
    },
    async save(input) {
      const account = validateAccount(input)
      if (input.id) await get(input.id)
      // Validate both protocols before replacing a working account.
      await network.imapSession(account, client => client.mailboxOpen('INBOX', { readOnly: true }))
      const smtp = await network.smtpTransport(account)
      try {
        await smtp.verify()
      } catch {
        throw mailError('email_smtp_failed')
      } finally {
        smtp.close()
      }
      const id = await mutate(accounts => {
        if (input.id && !accounts[input.id]) throw mailError('email_account_missing')
        if (
          input.id &&
          (accounts[input.id].email !== account.email ||
            accounts[input.id].username !== account.username ||
            JSON.stringify(accounts[input.id].imap) !== JSON.stringify(account.imap))
        )
          throw mailError('email_account_identity_changed')
        const existing = Object.values(accounts).find(
          value =>
            value.email === account.email &&
            value.username === account.username &&
            value.imap.host === account.imap.host &&
            value.imap.port === account.imap.port
        )
        const id = input.id ?? existing?.id ?? randomUUID()
        accounts[id] = { ...account, id }
        return id
      })
      return { id }
    },
    remove({ id }) {
      return mutate(accounts => {
        delete accounts[id]
      })
    },
  }
}

function validateAccount(input) {
  const text = key => {
    const value = input[key]
    if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\r\n\0]/.test(value))
      throw mailError()
    return value
  }
  const server = value => {
    if (
      !value ||
      typeof value.host !== 'string' ||
      !/^[a-zA-Z0-9.-]+$/.test(value.host) ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535 ||
      typeof value.secure !== 'boolean'
    )
      throw mailError()
    return { host: value.host, port: value.port, secure: value.secure }
  }
  const email = text('email').trim()
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) throw mailError()
  return {
    email,
    username: text('username').trim(),
    password: text('password'),
    imap: server(input.imap),
    smtp: server(input.smtp),
  }
}
