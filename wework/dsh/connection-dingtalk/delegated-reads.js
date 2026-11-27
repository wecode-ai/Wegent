import { createHash } from 'node:crypto'

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function activeProfile(response) {
  const profile = nonEmptyString(response.currentProfile)
  if (!profile) throw authenticationRequired()
  return { profile, account: response.profiles?.find(row => row.profile === profile) }
}

export function activeAccountIdentity(response) {
  const { profile, account } = activeProfile(response)
  return accountIdentity(account, profile)
}

function accountIdentity(account, profile) {
  const userId = nonEmptyString(account?.userId)
  const organizationId = nonEmptyString(account?.corpId) ?? nonEmptyString(account?.orgId)
  return {
    profile,
    userId,
    organizationId,
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

export function accountProfiles(response) {
  if (!Array.isArray(response.profiles)) throw invalid('Missing account profiles')
  const profiles = new Map()
  for (const row of response.profiles) {
    if (!validProfilePart(row?.corpId) || !validProfilePart(row?.userId)) continue
    const profile = `${row.corpId}:${row.userId}`
    if (profiles.has(profile)) throw invalid('Duplicate DingTalk account profile')
    profiles.set(profile, { row, identity: accountIdentity(row, profile) })
  }
  return profiles
}

function validProfilePart(value) {
  return typeof value === 'string' && value !== '*' && /^[^-\s,:\u0000][^\s,:\u0000]*$/.test(value)
}

function accountChanged() {
  return Object.assign(new Error('The active DingTalk account or organization changed'), {
    code: 'dingtalk_account_changed',
  })
}

function authenticationRequired() {
  return Object.assign(new Error('Authorize the account'), { code: 'connector_auth_required' })
}

export async function verifyAccountToken(ctx, identity, readTool) {
  const status = await readTool(ctx, 'authStatus', { profile: identity.profile })
  if (['ciphertext_key_mismatch', 'dek_missing', 'keychain_unavailable'].includes(status.reason))
    throw Object.assign(new Error('DingTalk credentials could not be checked'), {
      code: 'dingtalk_credentials_unavailable',
    })
  if (status.authenticated !== true || status.token_valid !== true) throw authenticationRequired()
  if (identity.userId !== status.user_id || identity.organizationId !== status.corp_id)
    throw accountChanged()
}

export async function verifiedProfile(ctx, profile, readTool, response) {
  const profiles = accountProfiles(response ?? (await readTool(ctx, 'listProfiles')))
  const identity = profiles.get(profile)?.identity
  if (!identity) throw accountChanged()
  await verifyAccountToken(ctx, identity, readTool)
  return identity
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'dingtalk_response_invalid' })
}

function exactId(value) {
  if (!nonEmptyString(value) || /^-|[\s,\u0000]/u.test(value) || value === '*')
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

export async function exactConversation(ctx, source, until, readTool, validateNativePage) {
  if (source.kind === 'group') return source.id
  if (source.organizationId) {
    const { result } = await readTool(ctx, 'conversationInfo', {
      peer: source.id,
      profile: source.profile,
    })
    const conversation = Array.isArray(result) && result.length === 1 ? result[0] : result
    const info = conversation?.conversationInfo ?? conversation
    return exactId(info?.openConversationId)
  }
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
