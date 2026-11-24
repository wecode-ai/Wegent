import { createReadCursor } from './read-cursor.js'
import { readImages } from './read-images.js'

const PROVIDER_ID = '@wegent/dsh-connection-dingtalk/dingtalk'
const GROUP_CATCH_UP_WINDOW_MINUTES = 15
const READINESS_ERRORS = new Map([
  ['connector_auth_required', 'auth_required'],
  ['dingtalk_identity_changed', 'identity_required'],
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
      const selectedProfile = input.profile === undefined ? undefined : required(input, 'profile')
      const profile = selectedProfile ?? (await activeProfile(ctx))
      const authenticate = () =>
        selectedProfile ? verifiedIdentity(ctx, selectedProfile) : requireAuthentication(ctx)
      await authenticate()
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
        await authenticate()
        throw error
      }
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
      validateCollection(input)
      if (!input.dingtalkAccount) await ownIdentity(ctx, profile, identities)
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
      const profile = required(source, 'profile')
      const identity = source.dingtalkAccount
        ? await verifiedIdentity(ctx, profile, source.dingtalkAccount)
        : undefined
      const selfId = await ownIdentity(ctx, profile, identities, identity)
      if (state.training) return trainingHistory(ctx, source, state, selfId, readCursors)
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
      const profile = required(source, 'profile')
      const identity = source.dingtalkAccount
        ? await verifiedIdentity(ctx, profile, source.dingtalkAccount)
        : undefined
      const selfId = await ownIdentity(ctx, profile, identities, identity)
      const start = checkpoint?.after ?? required(source, 'enabledAfter')
      const now = Date.now()
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

async function readMessagePage(ctx, source, window, ownId) {
  if (source.dingtalkAccount) {
    const { response, conversationId } = await readSelectedConversation(ctx, source, window)
    return messagePage(source, response, ownId, window.cursor, conversationId)
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
  const response = await readTool(
    ctx,
    source.kind === 'group' && !allMessages ? 'listMentions' : 'searchMessages',
    args
  )
  return messagePage(source, response, ownId, window.cursor, selfConversationId)
}

function validateCollection(source) {
  if (source.dingtalkAccount) selectedConversation(source)
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

function messagePage(source, response, ownId, cursor, selfConversationId) {
  const events = normalizeMessages(source, response, ownId, selfConversationId)
  if (typeof response.result?.hasMore !== 'boolean') throw invalid('Missing pagination state')
  const hasMore = response.result.hasMore
  const nextCursor = hasMore ? required(response.result, 'nextCursor') : '0'
  if (hasMore && nextCursor === cursor) throw invalid('Pagination cursor did not advance')
  return { events, hasMore, nextCursor }
}

export function normalizeMessages(source, response, ownId, selfConversationId) {
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
    if (source.dingtalkAccount && direct && conversationId !== selfConversationId) continue
    if (!Array.isArray(conversation.messages)) throw invalid('Missing messages')
    for (const message of conversation.messages) {
      // Bot notifications can come from another account and feed our own task output back in.
      if (message.sendType === 'robot' || message.messageAiSendFlag !== undefined) continue
      const sender = required(message, 'senderOpenDingTalkId')
      const manualSelfMessage =
        !source.dingtalkAccount &&
        message.sendType === 'user' &&
        (!direct ||
          (source.scope !== 'all' && source.id === ownId && conversationId === selfConversationId))
      if (
        (sender === ownId && !manualSelfMessage) ||
        (direct && source.scope !== 'all' && sender !== source.id)
      )
        continue
      events.push({
        id: required(message, 'openMessageId'),
        eventType: 'message.received',
        text: required(message, 'content'),
        senderId: sender,
        senderName: message.sender ?? null,
        isOwn: sender === ownId,
        isSelfConversation: direct && manualSelfMessage && sender === ownId,
        at: messageSentAt(message),
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
    throw authenticationRequired()
  }
  return response.currentProfile
}

async function requireAuthentication(ctx) {
  const response = await readTool(ctx, 'authStatus')
  if (response.authenticated !== true || response.token_valid === false)
    throw authenticationRequired()
  return response
}

async function ownIdentity(ctx, profile, cache, identity) {
  const cached = cache.get(profile)
  if (cached && cached.expiresAt > Date.now()) return cached.id
  if (!identity) {
    const response = await readTool(ctx, 'listProfiles')
    const account = response.profiles?.find(row => row.profile === profile)
    if (!account) throw authenticationRequired()
    identity = {
      accountId: required(account, 'userId'),
      accountName: required(account, 'userName'),
    }
  }
  const users = await readTool(ctx, 'searchUsers', {
    query: identity.accountName,
    profile,
  })
  const user = users.result?.find(row => row.userId === identity.accountId)
  const id = required(user, 'openDingTalkId')
  cache.set(profile, { id, expiresAt: Date.now() + 60_000 })
  return id
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

    const rows = await accountProfiles(ctx)
    const current = rows.filter(({ row }) => row.isCurrent === true)
    details.candidates = rows
      .filter(({ row }) => row.status === 'active')
      .map(({ identity }) => identity)
    const selected =
      profile === undefined
        ? current.length === 1 && current[0].row.isOrgCurrent === true
          ? current[0]
          : undefined
        : rows.find(({ identity }) => identity.profile === profile)
    if (!selected)
      return {
        ...details,
        status: details.candidates.length ? 'identity_required' : 'auth_required',
      }

    details.identity = selected.identity
    await checkToken(ctx, selected.identity)
    const read = await verifyMessageRead(ctx, selected.identity.profile, sources)
    return { ...details, status: 'ready', permissions: { read, reply: 'unverified' } }
  } catch (error) {
    const status = READINESS_ERRORS.get(error.code) ?? 'error'
    return { ...details, status, code: error.code ?? 'dingtalk_response_invalid' }
  }
}

async function accountProfiles(ctx) {
  const response = await readTool(ctx, 'listProfiles')
  if (!Array.isArray(response.profiles)) throw invalid('Missing account profiles')
  const rows = new Map()
  for (const row of response.profiles) {
    if (!validProfilePart(row?.corpId) || !validProfilePart(row?.userId)) continue
    const profile = `${row.corpId}:${row.userId}`
    if (rows.has(profile)) throw invalid('Duplicate DingTalk account profile')
    rows.set(profile, {
      row,
      identity: {
        profile,
        accountId: row.userId,
        accountName: displayIdentityPart(row.userName, row.userId),
        organizationId: row.corpId,
        organizationName: displayIdentityPart(row.corpName, row.corpId),
      },
    })
  }
  return [...rows.values()]
}

async function verifiedIdentity(ctx, profile, expected) {
  const identity = (await accountProfiles(ctx)).find(
    row => row.identity.profile === profile
  )?.identity
  if (
    !identity ||
    (expected &&
      (identity.accountId !== expected.accountId ||
        identity.organizationId !== expected.organizationId ||
        identity.profile !== expected.profile))
  )
    throw changedIdentity()
  await checkToken(ctx, identity)
  return identity
}

async function checkToken(ctx, identity) {
  const status = await readTool(ctx, 'authStatus', { profile: identity.profile })
  if (['ciphertext_key_mismatch', 'dek_missing', 'keychain_unavailable'].includes(status.reason))
    throw Object.assign(new Error('DingTalk credentials could not be checked'), {
      code: 'dingtalk_credentials_unavailable',
    })
  if (status.authenticated !== true || status.token_valid !== true) throw authenticationRequired()
  if (identity.accountId !== status.user_id || identity.organizationId !== status.corp_id)
    throw changedIdentity()
}

async function verifyMessageRead(ctx, profile, sources) {
  if (sources === undefined) return 'unchecked'
  if (!Array.isArray(sources) || !sources.length) throw invalid('Select a conversation')
  const selected = sources.map(source => ({ ...selectedConversation(source), profile }))
  const now = Date.now()
  const window = {
    start: new Date(now - 1000).toISOString(),
    end: new Date(now).toISOString(),
    limit: 1,
    cursor: '0',
  }
  for (const source of selected) {
    const { response, conversationId } = await readSelectedConversation(ctx, source, window)
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

async function readSelectedConversation(ctx, source, window) {
  const { id, kind } = selectedConversation(source)
  const args = { ...window, limit: String(window.limit), profile: required(source, 'profile') }
  if (kind === 'group')
    return {
      response: await readTool(ctx, 'listMentions', { ...args, group: id }),
      conversationId: id,
    }

  const { result } = await readTool(ctx, 'conversationInfo', { peer: id, profile: args.profile })
  const conversation = Array.isArray(result) && result.length === 1 ? result[0] : result
  const conversationId = required(conversation, 'openConversationId')
  if (!validResourceId(conversationId)) throw invalid('Invalid direct conversation ID')
  const response = await readTool(ctx, 'searchMessages', {
    ...args,
    conversationIds: conversationId,
    senderIds: id,
  })
  return { response, conversationId }
}

function selectedConversation(source) {
  const id = required(source, 'id')
  if (
    !validResourceId(id) ||
    !['group', 'direct'].includes(source.kind) ||
    source.scope !== undefined ||
    source.collectionKey !== undefined
  )
    throw invalid('Select an exact direct conversation or group mention source')
  return { id, kind: source.kind }
}

function validResourceId(value) {
  return typeof value === 'string' && value !== '*' && /^[^-\s,\u0000][^\s,\u0000]*$/.test(value)
}

function validProfilePart(value) {
  return validResourceId(value) && !value.includes(':')
}

function displayIdentityPart(value, fallback) {
  return (typeof value === 'string' && value.trim()) || fallback
}

function changedIdentity() {
  return Object.assign(new Error('DingTalk account or organization changed'), {
    code: 'dingtalk_identity_changed',
  })
}

function authenticationRequired() {
  return Object.assign(new Error('Authorize the account'), { code: 'connector_auth_required' })
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
      throw authenticationRequired()
    throw invalid('DingTalk tool request failed')
  }
  return response
}
