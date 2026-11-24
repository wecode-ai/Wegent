// Scope autonomous replies independently of work collection, training and clarification.
const WINDOW_MS = 30 * 60_000
const EVENT_LIMIT = 50
const DISCONNECT_THRESHOLD_MS = 60_000

export function isReplySource(source) {
  return Boolean(
    source?.requireReplyIdentity === true ||
    source?.replyIdentity ||
    source?.policy?.autonomousReply === true
  )
}

export function assertReplySource(source, identity) {
  if (
    !['group', 'direct'].includes(source?.kind) ||
    source.scope !== undefined ||
    source.collectionKey !== undefined ||
    !text(source.id) ||
    source.id === '*' ||
    /[,\r\n]/.test(source.id) ||
    (source.kind === 'direct' && source.id === identity?.openId)
  )
    throw invalid(
      'Autonomous replies require one exact direct conversation or selected group mentions'
    )
}

export function shouldRecoverReplies(previous, now, recover) {
  return recover === true || now - timestamp(previous) > DISCONNECT_THRESHOLD_MS
}

export function isPlainReplyText(message) {
  const type = message.msgType ?? message.messageType
  return typeof type === 'string' && type.toLowerCase() === 'text' && text(message.content)
}

export function replyObservation(event, identity) {
  return { ...event, at: new Date(timestamp(event.at)).toISOString(), identity }
}

export async function recoverReplies(ctx, readTool, source, identity, after, now) {
  const since = timestamp(after)
  const start = new Date(Math.max(since, now - WINDOW_MS)).toISOString()
  const end = new Date(now).toISOString()
  const history = await inspectReplyHistory(ctx, readTool, source, identity, {
    start,
    end,
    limit: EVENT_LIMIT,
  })
  const gap =
    history.gap ??
    (since < now - WINDOW_MS ? { code: 'recovery_window_exceeded', start, end } : null)
  const candidates = history.complete || history.gap?.code === 'event_limit' ? history.events : []
  const events = candidates
    .filter(
      event =>
        event.author === 'other' &&
        event.plainText &&
        (source.kind === 'direct' || event.mentionedSelf)
    )
    .map(event => ({ ...event, identity, eventType: 'message.received' }))
  return {
    events,
    hasMore: false,
    nextCheckpoint: { after: end, cursor: '0', identity },
    gap,
    recovery: { start, end, cursor: end, complete: gap === null },
  }
}

export async function inspectReplyHistory(ctx, readTool, source, identity, window) {
  assertReplySource(source, identity)
  const { start, end, limit = EVENT_LIMIT, conversationId } = window
  const range = { start: timestamp(start), end: timestamp(end) }
  if (
    range.start > range.end ||
    range.end - range.start > 2 * WINDOW_MS + 60_000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > EVENT_LIMIT
  )
    throw invalid('Invalid DingTalk reply history window')
  const group = source.kind === 'group'
  if (group && conversationId !== undefined && conversationId !== source.id)
    throw invalid('Reply history belongs to another conversation')
  const page = await readTool(ctx, group ? 'listConversation' : 'listDirectConversation', {
    [group ? 'group' : 'peer']: source.id,
    profile: source.profile,
    time: new Date(range.end + 1).toISOString(),
    limit: String(limit + 1),
  })
  const observedId = group
    ? source.id
    : (conversationId ?? page.messages?.[0]?.conversationId ?? null)
  const result = (code, events = []) => ({
    identity,
    conversationId: observedId,
    events,
    complete: !code,
    gap: code ? { code, start, end } : null,
  })
  const selection = selectNativeMessages(page, observedId, range, limit)
  if (selection.code && selection.code !== 'event_limit') return result(selection.code)
  if (!selection.messages.length) return result(null)
  const recordRange = {
    start: selection.code
      ? Math.max(range.start, timestamp(selection.messages[0].createTime))
      : range.start,
    end: range.end,
  }
  const raw = await readAttributedPage(ctx, readTool, source, observedId, recordRange)
  if (!raw) return result('history_attribution_unverified')
  const events = compareRecords(
    selection.messages,
    raw,
    source,
    identity,
    observedId,
    !selection.code
  )
  if (!events) return result('history_attribution_unverified')
  if (events.some(event => event.topicId)) return result('topic_history_unverified')
  if (group) {
    const mentions = await readAttributedPage(ctx, readTool, source, observedId, recordRange, true)
    if (!mentions) return result('mention_window_incomplete')
    for (const event of events) {
      const mention = mentions.get(event.id)
      event.mentionedSelf = Boolean(
        mention &&
        mention.senderOpenDingTalkId === event.senderId &&
        timestamp(mention.createTime) === timestamp(event.at) &&
        (!event.plainText || mention.content === event.text)
      )
    }
  }
  return result(selection.code, events)
}

function selectNativeMessages(page, conversationId, range, limit) {
  if (
    page.contractVersion !== 'im.message-list.v1' ||
    !Array.isArray(page.messages) ||
    page.messages.length > limit + 1 ||
    page.paginationKnown !== true ||
    typeof page.hasMore !== 'boolean' ||
    page.failedCount !== 0 ||
    page.partial === true
  )
    return { code: 'history_coverage_unverified' }
  const messages = []
  const ids = new Set()
  let oldest = Infinity
  for (const message of page.messages) {
    if (
      !text(message.messageId) ||
      !text(conversationId) ||
      message.conversationId !== conversationId
    )
      throw invalid('Reply history belongs to another conversation')
    const at = timestamp(message.createTime)
    if (at > oldest || ids.has(message.messageId)) return { code: 'history_order_unverified' }
    oldest = at
    ids.add(message.messageId)
    if (at >= range.start && at <= range.end) messages.push(message)
  }
  const selected = messages.slice(0, limit).reverse()
  if (
    messages.length > limit ||
    (page.hasMore && oldest >= range.start && selected.length === limit)
  )
    return { code: 'event_limit', messages: selected }
  if (page.hasMore && oldest >= range.start) return { code: 'history_coverage_unverified' }
  return { code: null, messages: selected }
}

async function readAttributedPage(ctx, readTool, source, conversationId, range, mentions = false) {
  const response = await readTool(ctx, mentions ? 'listMentions' : 'searchMessages', {
    profile: source.profile,
    [mentions ? 'group' : 'conversationIds']: conversationId,
    start: new Date(range.start - 1).toISOString(),
    end: new Date(range.end + 1).toISOString(),
    limit: '100',
    cursor: '0',
  })
  const { conversationMessagesList: conversations, hasMore, nextCursor } = response.result ?? {}
  if (hasMore !== false) return null
  if (conversations === undefined && response.success === true && typeof nextCursor === 'string')
    return new Map()
  if (!Array.isArray(conversations)) return null
  const records = new Map()
  for (const row of conversations) {
    if (
      row.openConversationId !== conversationId ||
      row.singleChat !== (source.kind === 'direct') ||
      !Array.isArray(row.messages)
    )
      throw invalid('Attributed reply history belongs to another conversation')
    for (const message of row.messages) {
      const at = timestamp(message.createTime)
      if (at < range.start || at > range.end) continue
      if (!text(message.openMessageId) || records.has(message.openMessageId)) return null
      records.set(message.openMessageId, message)
    }
  }
  return records
}

function compareRecords(native, raw, source, identity, conversationId, complete) {
  if (complete && native.length !== raw.size) return null
  const events = []
  for (const message of native) {
    const original = raw.get(message.messageId)
    if (!original || timestamp(message.createTime) !== timestamp(original.createTime)) return null
    const senderId = original.senderOpenDingTalkId
    if (!text(senderId) || (text(message.senderId) && senderId !== message.senderId)) return null
    if (source.kind === 'direct' && ![source.id, identity.openId].includes(senderId))
      throw invalid('Reply history belongs to another participant')
    const plainText = isPlainReplyText(original)
    if (plainText && message.text !== original.content) return null
    events.push({
      id: original.openMessageId,
      at: new Date(timestamp(original.createTime)).toISOString(),
      text: plainText ? original.content : null,
      plainText,
      conversationId,
      senderId,
      author: replyAuthor(original, senderId === identity.openId),
      quotedMessageId: original.quotedMessage?.openMessageId ?? null,
      topicId: original.openConvThreadId ?? message.threadId ?? null,
    })
  }
  return events
}

export function replyAuthor(message, own) {
  if (own && message.messageAiSendFlag === 'DWS') return 'assistant'
  if (message.sendType !== 'user' || message.messageAiSendFlag !== undefined) return 'unknown'
  return own ? 'owner' : 'other'
}

function text(value) {
  return typeof value === 'string' && Boolean(value.trim())
}

function timestamp(value) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(at)) throw invalid('Invalid DingTalk reply message timestamp')
  return at
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'dingtalk_response_invalid' })
}
