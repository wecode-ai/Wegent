import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createStandInDingTalkFixture } from './stand-in-dingtalk-fixture.mjs'

const org = 'dots-org'
const owner = 'dots-owner'

export const DINGTALK_DELEGATION_IDS = Object.freeze({
  profile: `${org}:${owner}`,
  owner,
  peer: 'dots-peer',
  peer2: 'dots-other-peer',
  group: 'dots-group',
  otherGroup: 'dots-other-group',
  direct: 'dots-direct',
  otherDirect: 'dots-other-direct',
  org,
})

/** Replace only the DingTalk transport boundary of the native desktop flow. */
export function createDingTalkDelegationMailbox(options) {
  const baseline = createStandInDingTalkFixture(options)
  const root = join(options.resultDir, 'delegation-dingtalk')
  const fixtureSource = fileURLToPath(
    new URL('../fixtures/delegation-dingtalk-cli.rs', import.meta.url)
  )
  const binary = join(
    options.resultDir,
    process.platform === 'win32' ? 'delegation-dingtalk-cli.exe' : 'delegation-dingtalk-cli'
  )

  async function publishFile(name, content) {
    const destination = join(root, name)
    const pending = `${destination}.pending`
    await writeFile(pending, content)
    await rename(pending, destination)
  }

  async function records(name) {
    const value = await readFile(join(root, name), 'utf8')
    return value.trim().split('\n').filter(Boolean).map(JSON.parse)
  }

  async function setAccount({ userId, orgId }) {
    await publishFile('account.tsv', `${identity(userId)}\t${identity(orgId)}`)
  }

  return {
    async prepareApp(context) {
      await baseline.prepareApp(context)
      await mkdir(root, { recursive: true })
      await Promise.all([
        publishFile('messages.tsv', ''),
        publishFile('reads.jsonl', ''),
        publishFile('replies.jsonl', ''),
        publishFile('offline', 'false'),
        publishFile('unknown-receipt', ''),
        publishFile('delivery.tsv', ''),
        publishFile('matching-receipt', 'false'),
        setAccount({ userId: DINGTALK_DELEGATION_IDS.owner, orgId: DINGTALK_DELEGATION_IDS.org }),
      ])
      const preparedBinary = process.env.WEWORK_E2E_DWS_DELEGATION_FIXTURE_BIN
      if (preparedBinary) {
        await copyFile(preparedBinary, binary)
      } else {
        await promisify(execFile)('rustc', [fixtureSource, '--edition', '2021', '-o', binary])
      }
      context.appEnvironment.DWS_BINARY_PATH = binary
    },
    install: baseline.install,
    publish(messages) {
      return publishFile('messages.tsv', messages.map(channelRecord).join('\n'))
    },
    setOffline(offline) {
      return publishFile('offline', String(offline))
    },
    setAccount,
    setUnknownReceipt(messageId) {
      return publishFile('unknown-receipt', messageId == null ? '' : identity(messageId))
    },
    configureDelivery({ automatic, pending, rejected }) {
      const outcomes = automatic.map(({ id, conversationId }) => [id, 'automatic', conversationId])
      if (pending) outcomes.push([pending.id, 'manual', pending.conversationId])
      if (rejected) outcomes.push([rejected.id, 'rejected', rejected.conversationId])
      return publishFile(
        'delivery.tsv',
        outcomes.map(row => row.map(identity).join('\t')).join('\n')
      )
    },
    releaseMatchingReceipt() {
      return publishFile('matching-receipt', 'true')
    },
    replies: () => records('replies.jsonl'),
    reads: () => records('reads.jsonl'),
  }
}

function identity(value) {
  assert.equal(typeof value, 'string', 'DingTalk fixture IDs must be strings')
  assert.match(value, /^[\w-]+$/, 'DingTalk fixture IDs must be safe record identifiers')
  return value
}

function channelRecord(message) {
  const {
    id,
    at,
    conversationId,
    kind,
    senderId,
    text,
    mentioned,
    topicId,
    quotedMessageId,
    recalled,
    messageType,
    aiTagged,
  } = message
  assert.ok(kind === 'group' || kind === 'direct', 'Test messages require an explicit channel kind')
  assert.equal(typeof text, 'string', 'Test messages require text')
  const timestamp = new Date(at).toISOString()
  const native = {
    messageId: identity(id),
    conversationId: identity(conversationId),
    senderId: identity(senderId),
    sender: senderId,
    createTime: timestamp,
    text,
  }
  const search = {
    openMessageId: id,
    senderOpenDingTalkId: senderId,
    sender: senderId,
    createTime: timestamp,
    content: text,
    sendType: 'user',
    ...(topicId && { openConvThreadId: topicId }),
    ...(quotedMessageId && { quotedMessage: { openMessageId: quotedMessageId } }),
    ...(recalled && { isRecalled: true }),
    ...(messageType && { messageType }),
    ...(aiTagged && { messageAiSendFlag: true }),
  }
  return [
    timestamp,
    conversationId,
    kind,
    senderId,
    Number(mentioned === true),
    JSON.stringify(search),
    JSON.stringify(native),
  ].join('\t')
}
