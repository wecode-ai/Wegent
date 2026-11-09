import { createHash } from 'node:crypto'
import { imapSession, smtpTransport, mailError } from './email-client.js'

// Only the Executor's source-bound, natively reviewed MCP tool calls this endpoint.
export function createEmailSender(accounts, storage, network = { imapSession, smtpTransport }) {
  let pending = Promise.resolve()
  return input => {
    const result = pending.then(() => send(input))
    pending = result.catch(() => {})
    return result
  }
  async function send(input) {
    return accounts.use(input.source?.profile, account => deliver(input, account))
  }
  async function deliver(
    { source, messageId, workId, from, to, subject, text, reply = true, authorization },
    account
  ) {
    const authorizedReply =
      source?.policy?.askBeforeAct === false &&
      authorization === 'continuous_reply' &&
      reply === true
    const confirmed =
      authorization === 'one_time' ||
      (authorization === undefined && source?.policy?.askBeforeAct === true)
    if (source?.id !== 'INBOX' || source.kind !== 'inbox' || (!confirmed && !authorizedReply))
      throw mailError('email_confirmation_required')
    if (
      ![to, subject, text, workId, messageId].every(
        value => typeof value === 'string' && value.trim()
      ) ||
      /[\r\n\0]/.test(to + subject) ||
      text.length > 20000 ||
      subject.length > 998 ||
      !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(to)
    )
      throw mailError()
    if (from !== account.email) throw mailError('email_sender_changed')
    const key = createHash('sha256')
      .update(
        JSON.stringify([source.profile, source.id, messageId, workId, to, subject, text, reply])
      )
      .digest('hex')
    const previous = await storage.get(key)
    if (previous) {
      if (previous === 'sent') return { status: 'sent', duplicate: true }
      throw mailError('email_send_unknown')
    }
    const mail = { from: account.email, to, subject, text, messageId: `<${key}@wework.local>` }
    if (reply) {
      const [validity, uid] = messageId.split(':')
      if (!/^\d+$/.test(validity) || !/^\d+$/.test(uid)) throw mailError()
      await network.imapSession(account, async client => {
        await client.mailboxOpen(source.id, { readOnly: true })
        if (String(client.mailbox.uidValidity) !== validity) throw mailError('email_mailbox_reset')
        const original = await client.fetchOne(Number(uid), { envelope: true }, { uid: true })
        if (!original) throw mailError('email_message_missing')
        const recipient = (
          original.envelope.replyTo?.length ? original.envelope.replyTo : original.envelope.from
        )?.[0]?.address
        if (recipient?.toLowerCase() !== to.toLowerCase())
          throw mailError('email_reply_recipient_changed')
        mail.inReplyTo = original.envelope.messageId
        mail.references = original.envelope.messageId
      })
    }
    const smtp = await network.smtpTransport(account)
    try {
      await smtp.verify()
    } catch {
      smtp.close()
      throw mailError('email_smtp_failed')
    }
    try {
      // Write ahead: an interrupted/partial SMTP transaction is never retried blindly.
      await storage.set(key, 'sending')
      const result = await smtp.sendMail(mail)
      if (result.rejected?.length || result.accepted?.length !== 1)
        throw mailError('email_send_unknown')
      await storage.set(key, 'sent')
      return { status: 'sent' }
    } catch (error) {
      if (
        [
          'CONN',
          'EHLO',
          'HELO',
          'STARTTLS',
          'AUTH',
          'AUTH PLAIN',
          'AUTH LOGIN',
          'MAIL FROM',
          'RCPT TO',
        ].includes(error.command) ||
        (error.responseCode >= 400 && error.responseCode <= 599)
      ) {
        await storage.delete(key)
        throw mailError('email_smtp_failed')
      }
      throw mailError('email_send_unknown')
    } finally {
      smtp.close()
    }
  }
}
