import { createReadCursor } from './read-cursor.js'

const PROVIDER_ID = '@wegent/dsh-connection-dingtalk/dingtalk'

export function createProvider() {
  const identities = new Map()
  const readCursors = createReadCursor()
  return {
    async check(ctx) {
      let authTarget
      try {
        authTarget = await ctx.cli.describe('dingtalk')
        await activeProfile(ctx)
        return { status: 'ready', authTarget }
      } catch (error) {
        return {
          status: error.code === 'connector_auth_required' ? 'auth_required' : 'error',
          code: error.code,
          authTarget,
        }
      }
    },
    async listResources(ctx, input) {
      const profile = await activeProfile(ctx)
      const kind = input.kind
      if (!['group', 'direct'].includes(kind)) throw invalid('Invalid conversation kind')
      if (input.scope === 'all') {
        return {
          items: [
            {
              providerId: PROVIDER_ID,
              profile,
              kind,
              id: '*',
              scope: 'all',
              name: kind === 'group' ? '所有群聊中 @我' : '所有联系人私聊',
            },
          ],
          hasMore: false,
        }
      }
      const query = required(input, 'query')
      if (query.length > 256) throw invalid('Search query is too long')
      const args = { query, profile }
      if (kind === 'group' && input.cursor) args.cursor = input.cursor
      const response = await readTool(ctx, kind === 'group' ? 'searchGroups' : 'searchUsers', args)
      const rows = kind === 'group' ? response.result?.groups : response.result
      if (!Array.isArray(rows)) throw invalid('Invalid search response')
      return {
        items: rows.map(row => ({
          id: required(row, kind === 'group' ? 'openConversationId' : 'openDingTalkId'),
          name: required(row, kind === 'group' ? 'title' : 'name'),
          kind,
          profile,
          providerId: PROVIDER_ID,
        })),
        hasMore: response.result?.hasMore === true,
        nextCursor: response.result?.nextCursor,
      }
    },
    async validate(ctx, input) {
      required(input, 'id')
      if (
        (input.scope === 'all') !== (input.id === '*') ||
        (input.scope !== undefined && input.scope !== 'all')
      )
        throw invalid('Invalid resource scope')
      const profile = required(input, 'profile')
      if (!['group', 'direct'].includes(input.kind)) throw invalid('Invalid conversation kind')
      await ownIdentity(ctx, profile, identities)
      return input
    },
    async initialize(_ctx, input) {
      return { after: required(input, 'enabledAfter'), cursor: '0' }
    },
    async readSource(ctx, input) {
      const { source } = input
      if (
        source?.providerId !== PROVIDER_ID ||
        !['group', 'direct'].includes(source.kind) ||
        source.scope !== undefined ||
        required(source, 'id') === '*' ||
        /[,\r\n]/.test(source.id)
      )
        throw invalid('Read an exact connected conversation')
      const state =
        input.cursor === undefined
          ? { ...readWindow(input.query ?? {}), issuedAt: Date.now() }
          : readCursors.decode(source, { ...input.query, cursor: input.cursor })
      const selfId = await ownIdentity(ctx, required(source, 'profile'), identities)
      const page = await readTool(
        ctx,
        source.kind === 'group' ? 'listConversation' : 'listDirectConversation',
        {
          [source.kind === 'group' ? 'group' : 'peer']: source.id,
          profile: source.profile,
          time: state.time ?? state.end,
          limit: String(state.limit),
        }
      )
      if (
        page.contractVersion !== 'im.message-list.v1' ||
        !Array.isArray(page.messages) ||
        page.messages.length > state.limit ||
        page.paginationKnown !== true ||
        typeof page.hasMore !== 'boolean' ||
        page.failedCount !== 0 ||
        page.partial === true
      )
        throw invalid('Incomplete native conversation response')
      const since = Date.parse(state.start)
      const until = Date.parse(state.end)
      const messages = page.messages.map(message =>
        nativeMessage(message, source, selfId, state.limit)
      )
      const reachedStart = messages.some(message => Date.parse(message.at) < since)
      const items = messages.filter(
        message => Date.parse(message.at) >= since && Date.parse(message.at) <= until
      )
      const hasMore = page.hasMore && !reachedStart
      const time = hasMore ? required(page.nextPage, 'time') : undefined
      if (hasMore && (!Number.isFinite(Date.parse(time)) || time === (state.time ?? state.end)))
        throw invalid('Invalid native conversation pagination')
      return {
        items,
        range: { since: state.start, until: state.end },
        hasMore,
        ...(hasMore ? { nextCursor: readCursors.encode(source, { ...state, time }) } : {}),
        contextComplete: !hasMore,
        readOnly: true,
      }
    },
    async collect(ctx, { source, checkpoint }) {
      try {
        const selfId = await ownIdentity(ctx, required(source, 'profile'), identities)
        const start = checkpoint?.after ?? required(source, 'enabledAfter')
        const until = checkpoint?.until ?? new Date().toISOString()
        const cursor = checkpoint?.cursor ?? '0'
        const {
          events,
          hasMore,
          nextCursor: next,
        } = await readMessagePage(ctx, source, { start, end: until, limit: 100, cursor }, selfId)
        return {
          events,
          nextCheckpoint: hasMore
            ? { after: start, until, cursor: next }
            : { after: until, cursor: '0' },
          hasMore,
        }
      } catch (error) {
        if (
          [
            'connection_cli_timeout',
            'ECONNRESET',
            'ECONNREFUSED',
            'ETIMEDOUT',
            'EHOSTUNREACH',
            'ENETUNREACH',
            'EAI_AGAIN',
          ].includes(error.code)
        )
          error.retryAfterMs ??= 30000
        throw error
      }
    },
  }
}

function nativeMessage(message, source, ownId, limit) {
  const at = required(message, 'createTime')
  if (!Number.isFinite(Date.parse(at))) throw invalid('Invalid native message time')
  const text = required(message, 'text')
  const budget = Math.min(20000, Math.floor(24000 / limit))
  const conversationId = required(message, 'conversationId')
  if (source.kind === 'group' && conversationId !== source.id)
    throw invalid('Native message belongs to another conversation')
  return {
    id: required(message, 'messageId'),
    eventType: 'message.received',
    at,
    text: text.slice(0, budget),
    truncated: text.length > budget,
    senderId: message.senderId ?? null,
    senderName: message.sender ?? null,
    isOwn: message.senderId === ownId,
    conversationId,
    topicId: message.threadId ?? null,
    ...(message.quotedMessage ? { quotedMessage: boundedQuote(message.quotedMessage) } : {}),
  }
}

function boundedQuote(value) {
  const json = JSON.stringify(value)
  return { text: json.slice(0, 2000), truncated: json.length > 2000 }
}

function readWindow(input) {
  const now = Date.now()
  const start = input.since === undefined ? new Date(now - 86400000).toISOString() : input.since
  const since = typeof start === 'string' ? Date.parse(start) : NaN
  const limit = input.limit === undefined ? 20 : input.limit
  if (
    !Number.isFinite(since) ||
    since < now - 7 * 86400000 ||
    since > now ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw invalid('Read at most twenty messages from the past seven days')
  return { start, end: new Date(now).toISOString(), limit }
}

async function readMessagePage(ctx, source, window, ownId) {
  const args = { ...window, limit: String(window.limit), profile: required(source, 'profile') }
  if (source.scope !== 'all') {
    if (source.kind === 'group') args.group = required(source, 'id')
    else args.senderIds = required(source, 'id')
  }
  const response = await readTool(
    ctx,
    source.kind === 'group' ? 'listMentions' : 'searchMessages',
    args
  )
  return messagePage(source, response, ownId, window.cursor)
}

function messagePage(source, response, ownId, cursor) {
  const events = normalizeMessages(source, response, ownId)
  if (typeof response.result?.hasMore !== 'boolean') throw invalid('Missing pagination state')
  const hasMore = response.result.hasMore
  const nextCursor = hasMore ? required(response.result, 'nextCursor') : '0'
  if (hasMore && nextCursor === cursor) throw invalid('Pagination cursor did not advance')
  return { events, hasMore, nextCursor }
}

export function normalizeMessages(source, response, ownId) {
  if (
    response.success === true &&
    response.result?.hasMore === false &&
    response.result.conversationMessagesList === undefined &&
    typeof response.result.nextCursor === 'string'
  )
    return []
  const conversations = response.result?.conversationMessagesList
  if (!Array.isArray(conversations)) throw invalid('Missing conversation messages')
  const events = []
  for (const conversation of conversations) {
    if (typeof conversation.singleChat !== 'boolean') throw invalid('Missing conversation kind')
    const direct = conversation.singleChat
    if (direct !== (source.kind === 'direct')) continue
    const conversationId = required(conversation, 'openConversationId')
    if (!direct && source.scope !== 'all' && conversationId !== source.id) continue
    if (!Array.isArray(conversation.messages)) throw invalid('Missing messages')
    for (const message of conversation.messages) {
      const sender = required(message, 'senderOpenDingTalkId')
      const manualSelfMention =
        !direct && message.sendType === 'user' && message.messageAiSendFlag === undefined
      if (
        (sender === ownId && !manualSelfMention) ||
        (direct && source.scope !== 'all' && sender !== source.id)
      )
        continue
      events.push({
        id: required(message, 'openMessageId'),
        eventType: 'message.received',
        text: required(message, 'content'),
        senderId: sender,
        senderName: message.sender ?? null,
        at: required(message, 'createTime'),
        conversationId,
        quotedMessageId: message.quotedMessage?.openMessageId ?? null,
        topicId: message.openConvThreadId ?? null,
        ...(source.scope === 'all'
          ? {
              resource: {
                id: direct ? sender : conversationId,
                kind: source.kind,
                name: direct ? message.sender || sender : conversation.title || conversationId,
              },
            }
          : {}),
      })
    }
  }
  return events
}

async function activeProfile(ctx) {
  const response = await readTool(ctx, 'listProfiles')
  if (typeof response.currentProfile !== 'string' || !response.currentProfile) {
    throw Object.assign(new Error('Authorize the account'), {
      code: 'connector_auth_required',
    })
  }
  return response.currentProfile
}

async function ownIdentity(ctx, profile, cache) {
  const cached = cache.get(profile)
  if (cached && cached.expiresAt > Date.now()) return cached.id
  const response = await readTool(ctx, 'listProfiles')
  const account = response.profiles?.find(row => row.profile === profile)
  if (!account)
    throw Object.assign(new Error('Authorize the account'), {
      code: 'connector_auth_required',
    })
  const users = await readTool(ctx, 'searchUsers', {
    query: required(account, 'userName'),
    profile,
  })
  const user = users.result?.find(row => row.userId === account.userId)
  const id = required(user, 'openDingTalkId')
  cache.set(profile, { id, expiresAt: Date.now() + 60_000 })
  return id
}

function required(value, key) {
  if (typeof value?.[key] !== 'string' || !value[key].trim()) throw invalid(`Missing ${key}`)
  return value[key]
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'dingtalk_response_invalid' })
}

async function readTool(ctx, tool, args = {}) {
  const response = await ctx.cli.callTool('dingtalk', { tool, arguments: args })
  if (
    !response ||
    typeof response !== 'object' ||
    response.success === false ||
    response.ok === false
  ) {
    const code = response?.error?.code ?? response?.errorCode ?? response?.code
    if (['need_login', 'AUTH_REQUIRED', 'connector_auth_required', 'NOT_LOGGED_IN'].includes(code))
      throw Object.assign(new Error('Authorize the account'), {
        code: 'connector_auth_required',
      })
    throw invalid('DingTalk tool request failed')
  }
  return response
}
