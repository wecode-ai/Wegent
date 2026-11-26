import {
  accountProfiles,
  activeAccountIdentity,
  boundAccount,
  delegatedMessageContext,
  exactConversation,
  validateDelegatedSource,
  verifiedProfile,
  verifyAccountToken,
} from './delegated-reads.js'
import { createReadCursor } from './read-cursor.js'
import { readImages } from './read-images.js'

const PROVIDER_ID = '@wegent/dsh-connection-dingtalk/dingtalk'
const GROUP_CATCH_UP_WINDOW_MINUTES = 15
const DELEGATION_CATCH_UP_MS = 30 * 60_000
const DELEGATION_CATCH_UP_MESSAGES = 50
const MAX_DELEGATION_CATCH_UP_PAGES = 8
const READINESS_ERRORS = new Map([
  ['connector_auth_required', 'auth_required'],
  ['dingtalk_account_changed', 'identity_required'],
  ['dingtalk_permissions_required', 'permissions_required'],
])

export function createProvider() {
  const identities = new Map()
  const readCursors = createReadCursor()
  return {
    async check(ctx, input) {
      if (input?.readiness === true) return connectionReadiness(ctx, input)
      let authTarget
      try {
        authTarget = await ctx.cli.describe('dingtalk')
        await requireAuthentication(ctx)
        const account = activeAccountIdentity(await readTool(ctx, 'listProfiles'))
        return { status: 'ready', authTarget, ...accountDisplay(account) }
      } catch (error) {
        return {
          status: error.code === 'connector_auth_required' ? 'auth_required' : 'error',
          code: error.code,
          authTarget,
        }
      }
    },
    async listResources(ctx, input) {
      const selected =
        input.profile === undefined
          ? undefined
          : await verifiedProfile(ctx, input.profile, readTool)
      const { profile, accountId } =
        selected ?? activeAccountIdentity(await readTool(ctx, 'listProfiles'))
      if (!selected) await requireAuthentication(ctx)
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
      let response
      try {
        response = await readTool(ctx, kind === 'group' ? 'searchGroups' : 'searchUsers', args)
      } catch (error) {
        if (
          !['connection_cli_request_unavailable', 'connection_cli_request_failed'].includes(
            error.code
          )
        )
          throw error
        // A token can expire between connection checks. Re-read auth state before
        // showing a generic provider failure.
        if (selected) await verifyAccountToken(ctx, selected, readTool)
        else await requireAuthentication(ctx)
        throw error
      }
      const rows = kind === 'group' ? response.result?.groups : response.result
      if (!Array.isArray(rows)) throw invalid('Invalid search response')
      if (selected) await verifyAccountToken(ctx, selected, readTool)
      return {
        items: rows.map(row => ({
          id: required(row, kind === 'group' ? 'openConversationId' : 'openDingTalkId'),
          name: required(row, kind === 'group' ? 'title' : 'name'),
          kind,
          profile,
          ...(accountId && { accountId }),
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
      required(input, 'profile')
      if (!['group', 'direct'].includes(input.kind)) throw invalid('Invalid conversation kind')
      validateCollection(input)
      if (input.delegated === true) validateDelegatedSource(input)
      else await ownIdentity(ctx, input, identities)
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
      if (input.query?.delegatedMessage !== undefined) {
        if (
          source.delegated !== true ||
          input.cursor !== undefined ||
          Object.keys(input.query).length !== 1
        )
          throw invalid('The exact delegated message read does not take additional options')
        const selfId = await ownIdentity(ctx, source, identities)
        const result = await delegatedMessageContext(
          ctx,
          source,
          input.query.delegatedMessage,
          selfId,
          { readTool, validateNativePage, normalizeMessages }
        )
        await boundAccount(ctx, source, readTool)
        return result
      }
      const state =
        input.cursor === undefined
          ? { ...readWindow(input.query ?? {}), issuedAt: Date.now() }
          : readCursors.decode(source, { ...input.query, cursor: input.cursor })
      const selfId = await ownIdentity(ctx, source, identities)
      if (state.training) {
        const result = await trainingHistory(ctx, source, state, selfId, readCursors)
        if (source.delegated === true) await boundAccount(ctx, source, readTool)
        return result
      }
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
      validateNativePage(page, state.limit)
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
      if (state.includeImages) {
        for (const item of items) {
          const original = page.messages.find(message => message.messageId === item.id)
          item.images = await readImages(ctx, source, original, readTool)
        }
      }
      const time = hasMore ? required(page.nextPage, 'time') : undefined
      if (hasMore && (!Number.isFinite(Date.parse(time)) || time === (state.time ?? state.end)))
        throw invalid('Invalid native conversation pagination')
      if (source.delegated === true) await boundAccount(ctx, source, readTool)
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
      validateCollection(source)
      const selfId = await ownIdentity(ctx, source, identities)
      const start = checkpoint?.after ?? required(source, 'enabledAfter')
      const now = Date.now()
      if (source.delegated === true) {
        const page = await collectDelegatedMessages(ctx, source, start, now, selfId)
        await boundAccount(ctx, source, readTool)
        return page
      }
      const boundedGroup = source.collectionKey === 'all-messages'
      const windowMinutes = boundedGroup ? checkpoint?.windowMinutes : undefined
      const windowEnd = boundedGroup
        ? Math.min(
            now,
            Date.parse(start) + (windowMinutes ?? GROUP_CATCH_UP_WINDOW_MINUTES) * 60_000
          )
        : now
      const until = checkpoint?.until ?? new Date(windowEnd).toISOString()
      const cursor = checkpoint?.cursor ?? '0'
      const {
        events,
        hasMore,
        nextCursor: next,
      } = await readMessagePage(ctx, source, { start, end: until, limit: 100, cursor }, selfId)
      const catchingUp = boundedGroup && Date.parse(until) < now
      const nextCheckpoint = hasMore
        ? { after: start, until, cursor: next }
        : { after: until, cursor: '0' }
      if (windowMinutes !== undefined && (hasMore || catchingUp))
        nextCheckpoint.windowMinutes = windowMinutes
      return {
        events,
        nextCheckpoint,
        hasMore: hasMore || catchingUp,
      }
    },
  }
}

async function collectDelegatedMessages(ctx, source, from, now, ownId) {
  const fromTime = Date.parse(from)
  if (!Number.isFinite(fromTime) || fromTime > now)
    throw invalid('Invalid DingTalk delegation checkpoint')
  const until = new Date(now).toISOString()
  const nextCheckpoint = { after: until, cursor: '0' }
  const gap = reason => ({
    events: [],
    hasMore: false,
    nextCheckpoint: { ...nextCheckpoint, delegationGap: { reason, from, until } },
  })
  if (now - fromTime > DELEGATION_CATCH_UP_MS) return gap('duration')

  const events = new Map()
  const cursors = new Set()
  let cursor = '0'
  // No page may enter the inbox before the entire bounded window is checked.
  for (let page = 0; page < MAX_DELEGATION_CATCH_UP_PAGES; page++) {
    if (cursors.has(cursor)) throw invalid('DingTalk delegation pagination repeated a cursor')
    cursors.add(cursor)
    const result = await readMessagePage(
      ctx,
      source,
      { start: from, end: until, limit: DELEGATION_CATCH_UP_MESSAGES + 1, cursor },
      ownId
    )
    for (const event of result.events) {
      const at = Date.parse(event.at)
      if (at <= fromTime || at > now || event.recalled) continue
      events.set(event.id, event)
      if (events.size > DELEGATION_CATCH_UP_MESSAGES) return gap('volume')
    }
    if (!result.hasMore) return { events: [...events.values()], nextCheckpoint, hasMore: false }
    cursor = result.nextCursor
  }
  throw invalid('DingTalk delegation collection could not complete within the page limit')
}

function messageSentAt(message) {
  const at = required(message, 'createTime')
  if (!Number.isFinite(Date.parse(at))) throw invalid('Invalid DingTalk message send time')
  return at
}

function nativeMessage(message, source, ownId, limit) {
  const text = required(message, 'text')
  const budget = Math.min(20000, Math.floor(24000 / limit))
  const conversationId = required(message, 'conversationId')
  if (source.kind === 'group' && conversationId !== source.id)
    throw invalid('Native message belongs to another conversation')
  return {
    id: required(message, 'messageId'),
    eventType: 'message.received',
    at: messageSentAt(message),
    text: text.slice(0, budget),
    truncated: text.length > budget,
    senderId: message.senderId ?? null,
    senderName: message.sender ?? null,
    isOwn: message.senderId === ownId,
    isSelfConversation: source.kind === 'direct' && source.id === ownId,
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
  const includeImages = input.includeImages ?? false
  if (
    typeof includeImages !== 'boolean' ||
    !Number.isFinite(since) ||
    (input.trainingUntil === undefined && since < now - 7 * 86400000) ||
    since > now ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw invalid('Read at most twenty messages from the past seven days')
  if (input.trainingUntil !== undefined) {
    const end = Date.parse(input.trainingUntil)
    if (!Number.isFinite(end) || end <= since || end > now || includeImages)
      throw invalid('Invalid training window')
    const earliest = now - 7 * 86400000
    return {
      start: new Date(Math.max(since, earliest)).toISOString(),
      requestedStart: start,
      end: input.trainingUntil,
      limit,
      training: true,
      ...(since < earliest ? { coverageGap: { since, through: Math.min(earliest, end) } } : {}),
    }
  }
  return { start, end: new Date(now).toISOString(), limit, includeImages }
}

// Read exact, attributed native records separately from the incoming-work collector.
async function trainingHistory(ctx, source, state, ownId, readCursors) {
  const mentions = source.kind === 'group' && source.collectionKey !== 'all-messages'
  const coverage = {
    reviewCoverage: mentions || state.coverageGap ? 'partial' : 'complete',
    ...(state.coverageGap ? { coverageGap: state.coverageGap } : {}),
  }
  if (Date.parse(state.start) >= Date.parse(state.end))
    return { items: [], hasMore: false, ...coverage }
  let conversationId = state.conversationId
  if (!conversationId && source.kind === 'direct') {
    const page = await readTool(ctx, 'listDirectConversation', {
      profile: source.profile,
      peer: source.id,
      time: state.end,
      limit: '1',
    })
    validateNativePage(page, 1)
    if (!page.messages.length) {
      if (page.hasMore) throw invalid('Missing peer conversation identity')
      return { items: [], hasMore: false, ...coverage }
    }
    conversationId = page.messages[0].conversationId
  }
  if (source.kind === 'group') conversationId = source.id
  if (typeof conversationId !== 'string' || !conversationId || /[,\r\n]/.test(conversationId))
    throw invalid('Invalid training conversation identity')
  const response = await readTool(ctx, mentions ? 'listMentions' : 'searchMessages', {
    profile: source.profile,
    [mentions ? 'group' : 'conversationIds']: conversationId,
    start: state.start,
    end: state.end,
    limit: String(state.limit),
    cursor: state.nativeCursor ?? '0',
  })
  const { conversationMessagesList, hasMore, nextCursor } = response.result ?? {}
  if (
    conversationMessagesList === undefined &&
    response.success === true &&
    hasMore === false &&
    typeof nextCursor === 'string'
  )
    return { items: [], hasMore: false, ...coverage }
  if (
    typeof hasMore !== 'boolean' ||
    !Array.isArray(conversationMessagesList) ||
    (hasMore &&
      (!nextCursor || typeof nextCursor !== 'string' || nextCursor === state.nativeCursor))
  )
    throw invalid('Incomplete attributed history')
  const items = []
  for (const conversation of conversationMessagesList) {
    if (
      conversation.openConversationId !== conversationId ||
      conversation.singleChat !== (source.kind === 'direct') ||
      !Array.isArray(conversation.messages)
    )
      throw invalid('Attributed history belongs to another conversation')
    for (const message of conversation.messages) {
      const at = Date.parse(message.createTime)
      if (
        !Number.isFinite(at) ||
        typeof message.openMessageId !== 'string' ||
        typeof message.content !== 'string'
      )
        throw invalid('Invalid training message')
      if (at < Date.parse(state.start) || at >= Date.parse(state.end)) continue
      const own = message.senderOpenDingTalkId === ownId
      const tagged = message.messageAiSendFlag !== undefined
      let author = 'unknown'
      if (own && tagged) author = 'accountAutomation'
      else if (!tagged && message.sendType === 'user' && message.senderOpenDingTalkId)
        author = own ? 'owner' : 'participant'
      const budget = Math.min(20000, Math.floor(24000 / state.limit))
      items.push({
        id: message.openMessageId,
        at: message.createTime,
        text: message.content.slice(0, budget),
        truncated: message.content.length > budget,
        author,
        ...(author === 'participant' ? { participantId: message.senderOpenDingTalkId } : {}),
        conversationId,
        isSelfConversation: source.kind === 'direct' && source.id === ownId,
        quotedMessageId: message.quotedMessage?.openMessageId ?? null,
        topicId: message.openConvThreadId ?? null,
      })
    }
  }
  if (items.length > state.limit) throw invalid('Training page exceeds its declared limit')
  return {
    items,
    hasMore,
    ...coverage,
    ...(hasMore
      ? {
          nextCursor: readCursors.encode(source, {
            ...state,
            conversationId,
            nativeCursor: nextCursor,
          }),
        }
      : {}),
  }
}

async function delegatedMessagePageRequest(ctx, source, window) {
  const conversationId = await exactConversation(
    ctx,
    source,
    window.end,
    readTool,
    validateNativePage
  )
  if (!conversationId) return undefined
  const args = { ...window, limit: String(window.limit), profile: required(source, 'profile') }
  if (source.kind === 'group') {
    return { tool: 'listMentions', args: { ...args, group: conversationId }, conversationId }
  }
  return {
    tool: 'searchMessages',
    args: { ...args, conversationIds: conversationId, senderIds: source.id },
    conversationId,
  }
}

async function readMessagePage(ctx, source, window, ownId) {
  if (source.delegated === true) {
    if (source.kind === 'direct' && source.id === ownId)
      return { events: [], hasMore: false, nextCursor: '0' }
    const request = await delegatedMessagePageRequest(ctx, source, window)
    if (!request) return { events: [], hasMore: false, nextCursor: '0' }
    return readCollectedMessagePage(ctx, source, window, ownId, request, {
      delegated: true,
      conversationId: request.conversationId,
    })
  }
  let selfConversationId
  if (source.kind === 'direct' && source.scope !== 'all' && source.id === ownId) {
    const page = await readTool(ctx, 'listDirectConversation', {
      peer: ownId,
      profile: required(source, 'profile'),
      time: window.end,
      limit: '1',
    })
    validateNativePage(page, 1)
    if (!page.messages.length) {
      if (page.hasMore) throw invalid('Missing native self conversation message')
      return { events: [], hasMore: false, nextCursor: '0' }
    }
    selfConversationId = required(page.messages[0], 'conversationId')
  }
  const args = { ...window, limit: String(window.limit), profile: required(source, 'profile') }
  const allMessages = source.collectionKey === 'all-messages'
  if (source.scope !== 'all') {
    if (source.kind === 'group')
      args[allMessages ? 'conversationIds' : 'group'] = required(source, 'id')
    else args.senderIds = required(source, 'id')
  }
  const tool = source.kind === 'group' && !allMessages ? 'listMentions' : 'searchMessages'
  return readCollectedMessagePage(
    ctx,
    source,
    window,
    ownId,
    { tool, args },
    { selfConversationId }
  )
}

async function readCollectedMessagePage(ctx, source, window, ownId, { tool, args }, options) {
  if (source.kind !== 'group') {
    const response = await readTool(ctx, tool, args)
    return messagePage(source, response, ownId, window.cursor, options)
  }

  const poll = {
    groupId: source.id,
    start: window.start,
    end: window.end,
    firstPage: window.cursor === '0',
    tool,
  }
  console.info('[wework-dingtalk-collection] poll started', JSON.stringify(poll))
  const filtered = []
  let returned
  let page
  try {
    const response = await readTool(ctx, tool, args)
    const conversations = response.result?.conversationMessagesList
    returned = Array.isArray(conversations)
      ? conversations.map(conversation => ({
          conversationId: diagnosticId(conversation?.openConversationId),
          messageIds: Array.isArray(conversation?.messages)
            ? conversation.messages.map(message => diagnosticId(message?.openMessageId))
            : null,
        }))
      : null
    page = messagePage(source, response, ownId, window.cursor, {
      ...options,
      reportFilter: entry => filtered.push(entry),
    })
    return page
  } finally {
    console.info(
      '[wework-dingtalk-collection] poll finished',
      JSON.stringify({
        ...poll,
        outcome: page ? 'normalized' : returned === undefined ? 'request_failed' : 'invalid_page',
        returned,
        filtered,
        acceptedMessageIds: page?.events.map(event => event.id),
        hasMore: page?.hasMore,
      })
    )
  }
}

function diagnosticId(value) {
  return typeof value === 'string' ? value : null
}

function validateCollection(source) {
  if (source.collectionKey === undefined) return
  if (
    source.collectionKey !== 'all-messages' ||
    source.kind !== 'group' ||
    source.scope !== undefined ||
    required(source, 'id') === '*' ||
    /[,\r\n]/.test(source.id)
  )
    throw invalid('All-message intake requires one exact group')
}

function validateNativePage(page, limit) {
  if (
    page.contractVersion !== 'im.message-list.v1' ||
    !Array.isArray(page.messages) ||
    page.messages.length > limit ||
    page.paginationKnown !== true ||
    typeof page.hasMore !== 'boolean' ||
    page.failedCount !== 0 ||
    page.partial === true
  )
    throw invalid('Incomplete native conversation response')
}

function messagePage(source, response, ownId, cursor, options) {
  const events = normalizeMessages(source, response, ownId, options.selfConversationId, options)
  if (typeof response.result?.hasMore !== 'boolean') throw invalid('Missing pagination state')
  const hasMore = response.result.hasMore
  const nextCursor = hasMore ? required(response.result, 'nextCursor') : '0'
  if (hasMore && nextCursor === cursor) throw invalid('Pagination cursor did not advance')
  return { events, hasMore, nextCursor }
}

export function normalizeMessages(source, response, ownId, selfConversationId, options = {}) {
  const { reportFilter } = options
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
    if (direct !== (source.kind === 'direct')) {
      reportFilter?.({
        conversationId: diagnosticId(conversation.openConversationId),
        reason: 'conversation_kind_mismatch',
      })
      continue
    }
    const conversationId = required(conversation, 'openConversationId')
    if (
      (!direct && source.scope !== 'all' && conversationId !== source.id) ||
      (options.conversationId && conversationId !== options.conversationId)
    ) {
      reportFilter?.({
        conversationId,
        reason: direct ? 'conversation_mismatch' : 'group_mismatch',
      })
      continue
    }
    if (!Array.isArray(conversation.messages)) throw invalid('Missing messages')
    for (const message of conversation.messages) {
      // Bot notifications can come from another account and feed our own task output back in.
      if (message.sendType === 'robot' || message.messageAiSendFlag !== undefined) {
        reportFilter?.({
          conversationId,
          messageId: diagnosticId(message.openMessageId),
          reason: message.sendType === 'robot' ? 'robot_message' : 'ai_generated_message',
        })
        continue
      }
      const sender = required(message, 'senderOpenDingTalkId')
      const isOwn = sender === ownId
      const manualSelfMessage =
        message.sendType === 'user' &&
        (!direct ||
          (source.scope !== 'all' && source.id === ownId && conversationId === selfConversationId))
      if (isOwn && (options.delegated ? !options.includeOwn : !manualSelfMessage)) {
        reportFilter?.({
          conversationId,
          messageId: diagnosticId(message.openMessageId),
          reason: options.delegated ? 'own_delegated_message' : 'non_manual_own_message',
        })
        continue
      }
      if (
        direct &&
        source.scope !== 'all' &&
        sender !== source.id &&
        !(isOwn && options.includeOwn)
      )
        continue
      const at = messageSentAt(message)
      const content =
        typeof message.content === 'string' && message.content.trim() ? message.content : undefined
      events.push({
        id: required(message, 'openMessageId'),
        eventType: 'message.received',
        text: options.delegated ? (content ?? '[Non-text message]') : required(message, 'content'),
        senderId: sender,
        senderName: message.sender ?? null,
        isOwn,
        isSelfConversation: direct && manualSelfMessage && isOwn,
        at: options.delegated ? new Date(Date.parse(at)).toISOString() : at,
        conversationId,
        quotedMessageId: message.quotedMessage?.openMessageId ?? null,
        topicId: message.openConvThreadId ?? null,
        ...(options.delegated && {
          textMessage: content !== undefined && isTextMessage(message),
          recalled: message.recalled === true || message.isRecalled === true,
        }),
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

function isTextMessage(message) {
  const type = message.messageType ?? message.msgType ?? message.contentType
  return type === undefined || (typeof type === 'string' && type.toLowerCase() === 'text')
}

function accountDisplay({ profile, accountId, accountName, organizationId, organizationName }) {
  return { profile, accountId, accountName, organizationId, organizationName }
}

async function connectionReadiness(ctx, { profile, sources }) {
  const details = {}
  try {
    details.authTarget = await ctx.cli.describe('dingtalk')
    const component = await readTool(ctx, 'componentInfo')
    if (!['managed', 'bundled', 'external'].includes(component.componentSource))
      throw invalid('Missing component source')
    details.component = {
      source: component.componentSource,
      version: required(component, 'version'),
    }

    const profiles = accountProfiles(await readTool(ctx, 'listProfiles'))
    const current = [...profiles.values()].filter(({ row }) => row.isCurrent === true)
    details.candidates = [...profiles.values()]
      .filter(({ row }) => row.status === 'active')
      .map(({ identity }) => readinessIdentity(identity))
    const selected =
      profile === undefined
        ? current.length === 1 && current[0].row.isOrgCurrent === true
          ? current[0]
          : undefined
        : profiles.get(profile)
    if (!selected)
      return {
        ...details,
        status: details.candidates.length ? 'identity_required' : 'auth_required',
      }
    details.identity = readinessIdentity(selected.identity)
    await verifyAccountToken(ctx, selected.identity, readTool)
    const read = await verifyMessageRead(ctx, selected.identity, sources)
    if (read === 'verified') await verifyAccountToken(ctx, selected.identity, readTool)
    return { ...details, status: 'ready', permissions: { read, reply: 'unverified' } }
  } catch (error) {
    return {
      ...details,
      status: READINESS_ERRORS.get(error.code) ?? 'error',
      code: error.code ?? 'dingtalk_response_invalid',
    }
  }
}

function readinessIdentity(identity) {
  return {
    ...accountDisplay(identity),
    accountName: identity.accountName ?? identity.userId,
    organizationName: identity.organizationName ?? identity.organizationId,
  }
}

async function verifyMessageRead(ctx, identity, sources) {
  if (sources === undefined) return 'unchecked'
  if (!Array.isArray(sources) || !sources.length) throw invalid('Select a conversation')
  const end = Date.now()
  const window = {
    start: new Date(end - 1000).toISOString(),
    end: new Date(end).toISOString(),
    limit: 1,
    cursor: '0',
  }
  for (const item of sources) {
    const source = { ...item, ...accountDisplay(identity), delegated: true }
    validateDelegatedSource(source)
    const request = await delegatedMessagePageRequest(ctx, source, window)
    if (!request) throw invalid('Message read permission could not be verified')
    const { tool, args, conversationId } = request
    const response = await readTool(ctx, tool, args)
    const { hasMore, conversationMessagesList, nextCursor } = response.result ?? {}
    if (
      response.success === true &&
      hasMore === false &&
      conversationMessagesList === undefined &&
      typeof nextCursor === 'string'
    )
      continue
    if (
      response.success !== true ||
      typeof hasMore !== 'boolean' ||
      !Array.isArray(conversationMessagesList) ||
      conversationMessagesList.some(
        conversation =>
          conversation.openConversationId !== conversationId ||
          conversation.singleChat !== (source.kind === 'direct') ||
          !Array.isArray(conversation.messages)
      )
    )
      throw invalid('Message read permission could not be verified')
  }
  return 'verified'
}

async function requireAuthentication(ctx) {
  const response = await readTool(ctx, 'authStatus')
  if (response.authenticated !== true || response.token_valid === false)
    throw Object.assign(new Error('Authorize the account'), {
      code: 'connector_auth_required',
    })
  return response
}

async function ownIdentity(ctx, source, cache) {
  const profile = required(source, 'profile')
  const delegated = source.delegated === true
  const bound = delegated ? await boundAccount(ctx, source, readTool) : null
  const key = bound?.accountId ?? profile
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.id
  const account =
    bound ?? (await readTool(ctx, 'listProfiles')).profiles?.find(row => row.profile === profile)
  if (!account)
    throw Object.assign(new Error('Authorize the account'), {
      code: 'connector_auth_required',
    })
  const users = await readTool(ctx, 'searchUsers', {
    query: required(account, bound ? 'accountName' : 'userName'),
    profile,
  })
  // A profile can be reassigned while the contact lookup is in flight.
  if (delegated) await boundAccount(ctx, source, readTool)
  const user = users.result?.find(row => row.userId === account.userId)
  const id = required(user, 'openDingTalkId')
  cache.set(key, { id, expiresAt: Date.now() + 60_000 })
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
