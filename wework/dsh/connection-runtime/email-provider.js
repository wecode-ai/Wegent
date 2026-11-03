import { imapSession, parseMail, mailError } from './email-client.js'

export const EMAIL_PROVIDER = '@wegent/dsh-connection-runtime/email'
const PAGE_SIZE = 20

export function createEmailProvider(accounts, network = { imapSession, parseMail }) {
  const session = async (ctx, source, action) =>
    network.imapSession(
      await accounts.get(source.profile),
      async client => {
        await client.mailboxOpen(source.id, { readOnly: true })
        return action(client)
      },
      ctx.signal
    )
  return {
    async check() {
      return { status: 'ready' }
    },
    async listResources(_ctx, { kind, query }) {
      if (kind !== 'inbox') throw mailError()
      const items = (await accounts.list())
        .filter(account => account.email.toLowerCase().includes(query.toLowerCase()))
        .map(account => ({
          providerId: EMAIL_PROVIDER,
          id: 'INBOX',
          kind: 'inbox',
          profile: account.id,
          name: account.email,
        }))
      return { items, hasMore: false }
    },
    async validate(_ctx, source) {
      if (source.kind !== 'inbox' || source.id !== 'INBOX') throw mailError()
      await accounts.get(source.profile)
      return source
    },
    async initialize(ctx, source) {
      if (source.boundary) return source.boundary
      return session(ctx, source, async client => ({
        partition: String(client.mailbox.uidValidity),
        sequence: client.mailbox.uidNext - 1,
      }))
    },
    async collect(ctx, { source, checkpoint }) {
      return session(ctx, source, async client => {
        if (String(client.mailbox.uidValidity) !== checkpoint.partition)
          throw mailError('email_mailbox_reset')
        if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0) throw mailError()
        const ceiling = client.mailbox.uidNext - 1
        if (checkpoint.sequence >= ceiling)
          return { events: [], nextCheckpoint: checkpoint, hasMore: false }
        const end = Math.min(ceiling, checkpoint.sequence + 1000)
        const uids = (
          await client.search({ uid: `${checkpoint.sequence + 1}:${end}` }, { uid: true })
        )
          .sort((a, b) => a - b)
          .slice(0, PAGE_SIZE)
        const events = []
        if (uids.length) {
          const rows = await client.fetchAll(
            uids,
            {
              uid: true,
              envelope: true,
              internalDate: true,
              size: true,
              source: { start: 0, maxLength: 262144 },
            },
            { uid: true }
          )
          for (const row of rows) {
            const mail = await network.parseMail(row.source)
            const sender = mail.from?.value?.[0]
            events.push({
              id: `${checkpoint.partition}:${row.uid}`,
              position: { partition: checkpoint.partition, sequence: row.uid },
              eventType: 'mail.received',
              at: new Date(row.internalDate).toISOString(),
              senderId: sender?.address ?? '',
              senderName: sender?.name ?? '',
              text: `Subject: ${mail.subject ?? ''}\nFrom: ${sender?.address ?? ''}\nReply-To: ${mail.replyTo?.value?.[0]?.address ?? sender?.address ?? ''}\n\n${(mail.text ?? '').slice(0, 20000)}${row.size > 262144 ? '\n[Message truncated]' : ''}`,
              topicId: mail.inReplyTo ?? mail.messageId ?? `${checkpoint.partition}:${row.uid}`,
            })
          }
        }
        const uid = uids.length === PAGE_SIZE ? uids.at(-1) : end
        return { events, nextCheckpoint: { ...checkpoint, sequence: uid }, hasMore: uid < ceiling }
      })
    },
  }
}
