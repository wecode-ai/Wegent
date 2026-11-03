import { createRequire } from 'node:module'
import { join } from 'node:path'

// Core DSH launches from the selected immutable Harness runtime. Its dependencies
// are owned there, while managed plugin source is copied into the user's profile.
const runtimeRequire = createRequire(join(process.cwd(), 'package.json'))

export async function imapSession(account, action, signal) {
  const { ImapFlow } = runtimeRequire('imapflow')
  const client = new ImapFlow({
    ...account.imap,
    doSTARTTLS: account.imap.secure ? undefined : true,
    auth: { user: account.username, pass: account.password },
    logger: false,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    maxLiteralSize: 2 * 1024 * 1024,
  })
  // EventEmitter errors must be consumed; awaited operations report failures.
  client.on('error', () => {})
  const abort = () => client.close()
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await client.connect()
    return await action(client)
  } catch (error) {
    if (error.code?.startsWith('email_')) throw error
    throw mailError('email_connection_failed')
  } finally {
    signal?.removeEventListener('abort', abort)
    client.close()
  }
}

export async function smtpTransport(account) {
  const nodemailer = runtimeRequire('nodemailer')
  return nodemailer.createTransport({
    ...account.smtp,
    requireTLS: !account.smtp.secure,
    auth: { user: account.username, pass: account.password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
}

export async function parseMail(source) {
  const { simpleParser } = runtimeRequire('mailparser')
  return simpleParser(source, { skipHtmlToText: false, skipTextToHtml: true })
}

export function mailError(code = 'email_invalid_configuration') {
  return Object.assign(new Error(code), { code })
}
