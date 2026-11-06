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
    throw imapError(error)
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
  try {
    return await simpleParser(source, { skipHtmlToText: false, skipTextToHtml: true })
  } catch {
    throw mailError('email_message_invalid')
  }
}

export function imapError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('email_')) return error
  if (error?.authenticationFailed === true) return mailError('email_auth_failed')
  // Cover platform socket errno variants and pinned ImapFlow disconnect codes.
  // Authentication, certificate and protocol failures require explicit recovery.
  const transportCodes = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'EPIPE',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'EHOSTDOWN',
    'ENETUNREACH',
    'ENETDOWN',
    'ENETRESET',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ETIMEOUT',
    'CONNECT_TIMEOUT',
    'GREETING_TIMEOUT',
    'UPGRADE_TIMEOUT',
    'NoConnection',
    'EConnectionClosed',
    'ClosedAfterConnectTLS',
    'ClosedAfterConnectText',
  ]
  if (transportCodes.includes(error?.code))
    return Object.assign(mailError('email_transport_failed'), { retryAfterMs: 30000 })
  return mailError('email_connection_failed')
}

export function mailError(code = 'email_invalid_configuration') {
  return Object.assign(new Error(code), { code })
}
