import { randomUUID } from 'node:crypto'
import { imapSession, parseMail, mailError } from './email-client.js'

export const EMAIL_PROVIDER = '@wegent/dsh-connection-runtime/email'
const PAGE_SIZE = 20
const DAY_MS = 24 * 60 * 60 * 1000

function readWindow({ since, limit = PAGE_SIZE }) {
  const now = Date.now()
  const start = since === undefined ? now - DAY_MS : Date.parse(since)
  if (
    (since !== undefined && typeof since !== 'string') ||
    !Number.isFinite(start) ||
    start < now - 7 * DAY_MS ||
    start > now ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PAGE_SIZE
  )
    throw mailError('email_read_range_invalid')
  return { since: new Date(start), until: new Date(now), limit }
}

export function createEmailProvider(accounts, network = { imapSession, parseMail }) {
  const readCursors = new Map()
  const binding = source =>
    JSON.stringify([source.providerId, source.profile, source.kind, source.id, source.enabledAfter])
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
    async readSource(ctx, input) {
      const { source } = input
      if (source?.providerId !== EMAIL_PROVIDER || source.kind !== 'inbox' || source.id !== 'INBOX')
        throw mailError()
      let state
      if (input.cursor !== undefined) {
        state = readCursors.get(input.cursor)
        if (
          !state ||
          state.binding !== binding(source) ||
          state.expiresAt < Date.now() ||
          (input.query?.since !== undefined &&
            Date.parse(input.query.since) !== state.window.since.getTime()) ||
          (input.query?.limit !== undefined && input.query.limit !== state.window.limit)
        )
          throw mailError('source_read_cursor_invalid')
      }
      const window = state?.window ?? readWindow(input.query ?? {})
      return session(ctx, source, async client => {
        const partition = String(client.mailbox.uidValidity)
        if (state && state.partition !== partition) throw mailError('email_mailbox_reset')
        const ceiling = state?.ceiling ?? client.mailbox.uidNext - 1
        const uids =
          ceiling < 1
            ? []
            : await client.search({ since: window.since, uid: '1:' + ceiling }, { uid: true })
        const selected = [...uids]
          .filter(uid => uid <= ceiling)
          .sort((a, b) => b - a)
          .slice(0, window.limit)
        const rows = selected.length
          ? await client.fetchAll(
              selected,
              {
                uid: true,
                internalDate: true,
                size: true,
                source: { start: 0, maxLength: 262144 },
              },
              { uid: true }
            )
          : []
        const items = []
        for (const row of rows) {
          const at = new Date(row.internalDate)
          if (!Number.isFinite(at.getTime())) throw mailError('email_message_invalid')
          if (at < window.since || at > window.until) continue
          const mail = await network.parseMail(row.source)
          const sender = mail.from?.value?.[0]
          items.push({
            id: `${client.mailbox.uidValidity}:${row.uid}`,
            at: at.toISOString(),
            subject: mail.subject ?? '',
            from: sender?.address ?? '',
            senderName: sender?.name ?? '',
            text: (mail.text ?? '').slice(0, 20000),
            truncated: row.size > 262144 || (mail.text?.length ?? 0) > 20000,
          })
        }
        items.sort((left, right) => right.at.localeCompare(left.at))
        const hasMore = uids.some(uid => uid < selected.at(-1))
        let nextCursor
        if (hasMore) {
          for (const [key, value] of readCursors)
            if (value.expiresAt < Date.now()) readCursors.delete(key)
          if (readCursors.size >= 1000) readCursors.delete(readCursors.keys().next().value)
          nextCursor = randomUUID()
          readCursors.set(nextCursor, {
            binding: binding(source),
            partition,
            window,
            ceiling: selected.at(-1) - 1,
            expiresAt: state?.expiresAt ?? Date.now() + 30 * 60 * 1000,
          })
        }
        return {
          items: items.slice(0, window.limit),
          range: { since: window.since.toISOString(), until: window.until.toISOString() },
          hasMore,
          ...(nextCursor ? { nextCursor } : {}),
          readOnly: true,
        }
      })
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
