import { createHash } from 'node:crypto'

const CONTEXT_LOOKBACK_MS = 24 * 60 * 60 * 1000
const MAX_CONTEXT_PAGES = 3
const MAX_CONTEXT_BYTES = 64_000

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function activeAccountIdentity(response) {
  const profile = nonEmptyString(response.currentProfile)
  if (!profile)
    throw Object.assign(new Error('Authorize the account'), { code: 'connector_auth_required' })
  const account = response.profiles?.find(row => row.profile === profile)
  const userId = nonEmptyString(account?.userId)
  const organizationId = nonEmptyString(account?.corpId) ?? nonEmptyString(account?.orgId)
  return {
    profile,
    ...(userId &&
      organizationId && {
        accountId: createHash('sha256')
          .update(JSON.stringify([profile, organizationId, userId]))
          .digest('hex'),
      }),
    accountName: nonEmptyString(account?.userName),
    organizationName: nonEmptyString(account?.orgName) ?? nonEmptyString(account?.corpName),
  }
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'dingtalk_response_invalid' })
}

function exactId(value) {
  if (!nonEmptyString(value) || /[\s,]/u.test(value) || value === '*')
    throw invalid('Delegation requires one exact DingTalk conversation')
  return value
}

export function validateDelegatedSource(source) {
  if (
    source.delegated !== true ||
    !['direct', 'group'].includes(source.kind) ||
    source.scope !== undefined ||
    source.collectionKey !== undefined ||
    !nonEmptyString(source.accountId)
  )
    throw invalid('Delegation permits only an exact direct conversation or group mentions')
  exactId(source.id)
}

export async function boundAccount(ctx, source, readTool) {
  validateDelegatedSource(source)
  const active = activeAccountIdentity(await readTool(ctx, 'listProfiles'))
  if (
    active.profile !== source.profile ||
    (active.accountId && active.accountId !== source.accountId)
  )
    throw Object.assign(new Error('The active DingTalk account changed'), {
      code: 'dingtalk_account_changed',
    })
  if (!active.accountId) throw invalid('The active DingTalk account cannot be verified')
  return active
}

export async function exactConversation(ctx, source, until, readTool, validateNativePage) {
  if (source.kind === 'group') return source.id
  const page = await readTool(ctx, 'listDirectConversation', {
    peer: source.id,
    profile: source.profile,
    time: until,
    limit: '1',
  })
  validateNativePage(page, 1)
  if (!page.messages.length && !page.hasMore) return undefined
  return exactId(page.messages[0]?.conversationId)
}

export async function delegatedMessageContext(ctx, source, trigger, ownId, provider) {
  const { readTool, validateNativePage, normalizeMessages } = provider
  const at = Date.parse(trigger.at)
  if (!Number.isFinite(at) || at > Date.now()) throw invalid('Invalid delegated message time')
  const until = new Date().toISOString()
  const conversationId = await exactConversation(ctx, source, until, readTool, validateNativePage)
  if (!conversationId || conversationId !== trigger.conversationId)
    throw invalid('The delegated message belongs to another conversation')
  const group = source.kind === 'group'
  const normalize = (page, includeOwn) =>
    normalizeMessages(source, page, ownId, undefined, {
      conversationId,
      delegated: true,
      includeOwn,
    })
  const params = { profile: source.profile, end: until }
  if (group) {
    const mentions = await contextPages(
      ctx,
      'listMentions',
      {
        ...params,
        group: conversationId,
        start: new Date(at - 1000).toISOString(),
        end: new Date(Math.min(Date.now(), at + 1000)).toISOString(),
      },
      page => normalize(page, false),
      readTool
    )
    if (!mentions.some(row => row.id === trigger.id && !row.recalled))
      throw invalid('The original message is no longer confirmed as a group mention')
  }
  const records = await contextPages(
    ctx,
    'searchMessages',
    {
      ...params,
      start: new Date(at - CONTEXT_LOOKBACK_MS).toISOString(),
      conversationIds: conversationId,
      ...(!group && { senderIds: `${source.id},${ownId}` }),
    },
    page => normalize(page, true),
    readTool
  )
  const target = records.find(row => row.id === trigger.id && !row.isOwn)
  if (!target || target.recalled || Date.parse(target.at) !== at)
    throw invalid('The original message is missing or changed')
  const later = records.filter(row => row.id !== target.id && Date.parse(row.at) >= at)
  const related = group ? relatedGroupMessages(target, later) : later
  const messages = records.filter(row => Date.parse(row.at) < at)
  return {
    items: messages,
    hasMore: false,
    accountId: source.accountId,
    target,
    messages,
    laterMessages: related.filter(row => !row.isOwn),
    ownerIntervened: related.some(row => row.isOwn),
  }
}

async function contextPages(ctx, tool, query, normalize, readTool) {
  let cursor = '0'
  const seen = new Set([cursor])
  const items = new Map()
  let bytes = 0
  for (let index = 0; index < MAX_CONTEXT_PAGES; index += 1) {
    const page = await readTool(ctx, tool, { ...query, limit: '100', cursor })
    for (const item of normalize(page)) {
      const previous = items.get(item.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(item))
        throw invalid('DingTalk context changed during pagination')
      if (!previous) bytes += Buffer.byteLength(item.text)
      if (item.text.length > 20_000 || bytes > MAX_CONTEXT_BYTES)
        throw invalid('The bounded DingTalk context is too large')
      items.set(item.id, item)
    }
    if (page.result?.hasMore === false)
      return [...items.values()].sort(
        (left, right) =>
          Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id)
      )
    const next = nonEmptyString(page.result?.nextCursor)
    if (page.result?.hasMore !== true || !next || seen.has(next))
      throw invalid('Incomplete DingTalk context pagination')
    cursor = next
    seen.add(cursor)
  }
  throw invalid('The bounded DingTalk context is incomplete')
}

function relatedGroupMessages(target, later) {
  const byId = new Map(later.map(row => [row.id, row]))
  return later.filter(row => {
    if (!row.quotedMessageId) return row.topicId === target.topicId
    const seen = new Set()
    let replyTo = row.quotedMessageId
    while (replyTo && !seen.has(replyTo)) {
      if (replyTo === target.id) return true
      seen.add(replyTo)
      replyTo = byId.get(replyTo)?.quotedMessageId
    }
    return false
  })
}
