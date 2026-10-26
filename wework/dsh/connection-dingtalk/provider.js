const PROVIDER_ID = '@wegent/dsh-connection-dingtalk/dingtalk'

export function createProvider() {
  const identities = new Map()
  return {
    async check(ctx) {
      try {
        await activeProfile(ctx)
        return { status: 'ready' }
      } catch (error) {
        return {
          status: error.code === 'connector_auth_required' ? 'auth_required' : 'error',
          code: error.code,
        }
      }
    },
    async listResources(ctx, input) {
      const profile = await activeProfile(ctx)
      const kind = input.kind
      if (!['group', 'direct'].includes(kind)) throw invalid('Invalid conversation kind')
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
      const profile = required(input, 'profile')
      if (!['group', 'direct'].includes(input.kind)) throw invalid('Invalid conversation kind')
      await ownIdentity(ctx, profile, identities)
      return input
    },
    async initialize(_ctx, input) {
      return { after: required(input, 'enabledAfter'), cursor: '0' }
    },
    async collect(ctx, { source, checkpoint }) {
      const profile = required(source, 'profile')
      const id = required(source, 'id')
      const selfId = await ownIdentity(ctx, profile, identities)
      const start = checkpoint?.after ?? required(source, 'enabledAfter')
      const until = checkpoint?.until ?? new Date().toISOString()
      const cursor = checkpoint?.cursor ?? '0'
      const args = { start, end: until, limit: '100', cursor, profile }
      if (source.kind === 'group') args.group = id
      else args.senderIds = id
      const response = await readTool(
        ctx,
        source.kind === 'group' ? 'listMentions' : 'searchMessages',
        args
      )
      const events = normalizeMessages(source, response, selfId)
      if (typeof response.result?.hasMore !== 'boolean') throw invalid('Missing pagination state')
      const hasMore = response.result.hasMore
      const next = hasMore ? required(response.result, 'nextCursor') : '0'
      if (hasMore && next === cursor) throw invalid('Pagination cursor did not advance')
      return {
        events,
        nextCheckpoint: hasMore
          ? { after: start, until, cursor: next }
          : { after: until, cursor: '0' },
        hasMore,
      }
    },
  }
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
    if (!direct && conversationId !== source.id) continue
    if (!Array.isArray(conversation.messages)) throw invalid('Missing messages')
    for (const message of conversation.messages) {
      const sender = required(message, 'senderOpenDingTalkId')
      const manualSelfMention =
        !direct && message.sendType === 'user' && message.messageAiSendFlag === undefined
      if ((sender === ownId && !manualSelfMention) || (direct && sender !== source.id)) continue
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
      })
    }
  }
  return events
}

async function activeProfile(ctx) {
  const response = await readTool(ctx, 'listProfiles')
  if (typeof response.currentProfile !== 'string' || !response.currentProfile) {
    throw Object.assign(new Error('pluginKey=dingtalk connectorSlug=dingtalk'), {
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
    throw Object.assign(new Error('pluginKey=dingtalk connectorSlug=dingtalk'), {
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
      throw Object.assign(new Error('pluginKey=dingtalk connectorSlug=dingtalk'), {
        code: 'connector_auth_required',
      })
    throw invalid('DingTalk tool request failed')
  }
  return response
}
