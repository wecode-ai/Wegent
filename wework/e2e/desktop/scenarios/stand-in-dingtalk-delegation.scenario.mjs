import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  currentExecutorPid,
  waitForRestartedExecutor,
} from '../modules/executor-restart-readiness.mjs'
import {
  assistantMessage,
  createSse,
  handleModelMaintenanceRequest,
  modelMessageText,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import {
  createDingTalkDelegationMailbox,
  DINGTALK_DELEGATION_IDS as ids,
} from '../modules/stand-in-dingtalk-delegation-fixture.mjs'
import { verifyDingTalkDelivery } from '../modules/stand-in-dingtalk-delivery.mjs'
import { STORY_USER, storyUntil } from '../modules/stand-in-source-story-evidence.mjs'

const PROVIDER = '@wegent/dsh-connection-dingtalk/dingtalk'
const COLLECTION_PROBE_ROLE = 'dingtalk-account-switch-probe'
const REPLY_LIMIT_MS = 120_000
// The positive batch queues 18 model decisions and can span multiple collection ticks.
const BATCH_DELIVERY_TIMEOUT_MS = 90_000
// The first transient failure retries after 30s on the next 15s collection tick.
const COLLECTION_RECOVERY_WAIT_MS = 60_000
const TEMPLATE_CONTENT = {
  document: {
    evidence: label => [
      `${label} 使用的是已批准分享的操作手册。`,
      `${label} 的现行手册可以用以下地址打开。`,
      `https://example.org/handbooks/${label}`,
    ],
    questions: ['手册链接是什么？', '能把刚才提到的手册发一下吗？', '那份文档的入口呢？'],
  },
  schedule: {
    evidence: label => [
      `${label} 安排在明天。`,
      `${label} 已确认下午三点开始。`,
      `${label} 地点定在 302 会议室。`,
    ],
    questions: ['什么时候、在哪开会？', '几点过去，去哪个会议室？', '刚才说的安排呢？'],
  },
  process: {
    evidence: label => [
      `${label} 第一步是核对版本号。`,
      `${label} 第二步是完成发布检查。`,
      `${label} 第三步是登记发布回执。`,
    ],
    questions: ['发布流程怎么走？', '之前定的步骤能再说一下吗？', '这回按哪几个步骤？'],
  },
}

function message(id, kind, text, at, overrides = {}) {
  return {
    id,
    kind,
    conversationId: ids[kind],
    senderId: ids.peer,
    mentioned: kind === 'group',
    topicId: id,
    text,
    at: new Date(at).toISOString(),
    ...overrides,
  }
}

function replyCase(id, kind, template, at, variant = 0) {
  const sample = TEMPLATE_CONTENT[template]
  const question = message(id, kind, `${id} ${sample.questions[variant]}`, at)
  const evidence = sample.evidence(id).map((text, index) =>
    message(`${id}-evidence-${index}`, kind, text, at - (3 - index) * 1000, {
      senderId: ids.owner,
      mentioned: false,
      topicId: id,
    })
  )
  const link = template === 'document' ? evidence[2].text : null
  return {
    question,
    evidence,
    decision: {
      action: 'reply',
      template,
      reason: `The same conversation confirms ${id}.`,
      evidence: evidence.map(row => ({ messageId: row.id, quote: row.text })),
      link,
    },
    text: link ?? evidence.map(row => row.text).join('\n'),
  }
}

function nonReplyCase(id, kind, action, reason, at, facts = []) {
  const question = message(id, kind, `${id} ${reason}`, at)
  const evidence = facts.map((text, index) =>
    message(`${id}-evidence-${index}`, kind, text, at - (facts.length - index) * 1000, {
      senderId: ids.owner,
      mentioned: false,
      topicId: id,
    })
  )
  return {
    question,
    evidence,
    decision: { action, reason, template: null, link: null, evidence: [] },
  }
}

function sameConversationEvidence(decisionContext, evidence) {
  for (const item of evidence) {
    const actual = decisionContext.earlierMessages.find(row => row.id === item.id)
    assert.ok(actual, `Missing original citation ${item.id} from the model input`)
    assert.equal(actual.conversationId, decisionContext.question.conversationId)
    assert.equal(actual.text, item.text)
  }
}

export function createDesktopScenario(options) {
  const mailbox = createDingTalkDelegationMailbox(options)
  const cases = new Map()
  const messages = new Map()
  const decisions = new Map()
  const results = []
  const timeout = options.modelResponseTimeoutMs
  const rpc = (control, method, params) =>
    requestExecutor(control, method, params, options.uiTimeoutMs)

  async function publish(newMessages) {
    for (const row of newMessages) messages.set(row.id, row)
    await mailbox.publish([...messages.values()])
  }

  async function publishCases(samples, extras = []) {
    for (const sample of samples) cases.set(sample.question.id, sample)
    await publish([...samples.flatMap(sample => [...sample.evidence, sample.question]), ...extras])
  }

  return {
    prepareApp: mailbox.prepareApp,
    diagnostics: () => ({ modelDecisions: [...decisions], results }),
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      if (handleModelMaintenanceRequest(body, response)) return true
      const prompt = modelMessageText((body.input ?? []).filter(row => row.role === 'user').at(-1))
      if (
        !prompt.includes('Decide whether the owner must answer this newly arrived DingTalk event.')
      ) {
        return false
      }
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
      const { id } = context.question
      const sample = cases.get(id)
      assert.ok(sample, `Unexpected model call for ${id}`)
      assert.equal(context.question.text, sample.question.text)
      assert.equal(context.question.conversationId, sample.question.conversationId)
      sameConversationEvidence(context, sample.evidence)
      decisions.set(id, (decisions.get(id) ?? 0) + 1)
      if (sample.changeBeforeRecheck) await publish([sample.changeBeforeRecheck])
      const responseId = `dingTalk-delegation-${id}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(JSON.stringify(sample.decision)),
          responseCompleted(responseId),
        ])
      )
      return true
    },
    async verify(control) {
      const request = (method, params = {}) => rpc(control, method, params)
      const settings = () => request('runtime.stand_in.personal.get', { userId: STORY_USER })
      const work = () =>
        request('runtime.stand_in.work.list', { userId: STORY_USER, roleId: '@primary' })
      assert.equal(options.executorHome, join(options.resultDir, 'executor-home'))
      const original = await settings()
      const db = new DatabaseSync(join(options.executorHome, 'data/tasks.sqlite'))
      db.exec('PRAGMA busy_timeout = 10000')
      const rows = type =>
        db
          .prepare(
            "SELECT metadata FROM loop_items WHERE resource_type=? AND json_extract(metadata, '$.userId')=?"
          )
          .all(type, STORY_USER)
          .map(row => JSON.parse(row.metadata))
      const sourceState = (kind, id = kind === 'direct' ? ids.peer : ids.group) =>
        rows('stand_in_source').find(row => row.source.kind === kind && row.source.id === id)
      const records = () => new Map(rows('stand_in_message').map(row => [row.id, row]))
      const awaitOutcomes = (ids, expected, label, timeoutMs = timeout) =>
        storyUntil(
          () => ids.map(id => records().get(id)?.delegationResult),
          outcomes => outcomes.every(outcome => outcome?.status === expected),
          timeoutMs,
          label
        )
      const visibleSourceError = (kind, predicate) =>
        storyUntil(
          work,
          snapshot => snapshot.sourceErrors.some(row => row.source.kind === kind && predicate(row)),
          timeout,
          `DingTalk ${kind} source must expose its recovery state`
        )
      const assertSilent = async (cases, { uncollected = false } = {}) => {
        const replies = await mailbox.replies()
        const current = records()
        for (const item of cases) {
          const id = item.id ?? item.question.id
          assert.ok(!replies.some(row => row.messageId === id), `${id} must not attempt a send`)
          if (uncollected) {
            assert.ok(!current.has(id), `${id} must not be ingested`)
            assert.ok(!decisions.has(id), `${id} must not reach the model`)
          }
        }
      }
      async function assertDelivered(samples, timeoutMs = timeout) {
        const idsToCheck = samples.map(sample => sample.question.id)
        const outcomes = await awaitOutcomes(
          idsToCheck,
          'sent',
          'Every reply must reach its channel receipt',
          timeoutMs
        )
        const replies = await mailbox.replies()
        samples.forEach((sample, index) => {
          const question = sample.question
          const result = outcomes[index]
          const external = replies.filter(row => row.messageId === question.id)
          assert.equal(external.length, 1, `${question.id} must be sent exactly once`)
          assert.deepEqual(
            {
              conversationId: external[0].conversationId,
              senderId: external[0].senderId,
              text: external[0].text,
              profile: external[0].profile,
            },
            {
              conversationId: question.conversationId,
              senderId: question.senderId,
              text: sample.text,
              profile: ids.profile,
            }
          )
          assert.equal(external[0].aiTag, true, 'Outgoing reply must have the native AI tag')
          assert.equal(external[0].offline, false)
          assert.match(external[0].uuid, /^[0-9a-f]{64}$/)
          assert.equal(external[0].uuid, result.attemptId)
          assert.equal(result.action, 'reply')
          assert.equal(result.template, sample.decision.template)
          assert.deepEqual(
            result.evidenceIds,
            sample.evidence.map(item => item.id)
          )
          assert.match(result.contextFingerprint, /^[0-9a-f]{64}$/)
          assert.equal(result.receiptId, `accepted-${question.id}`)
          const submitted = Date.parse(result.submittedAt)
          assert.ok(
            Date.parse(question.at) <= submitted && submitted <= Date.parse(result.finishedAt),
            `${question.id}: submission must be recorded between arrival and receipt`
          )
          const latency = Date.parse(result.finishedAt) - Date.parse(question.at)
          assert.ok(latency >= 0 && latency <= REPLY_LIMIT_MS, `${question.id}: ${latency}ms`)
          results.push({
            id: question.id,
            template: result.template,
            kind: question.kind,
            latency,
            policyVersion: result.policyVersion,
            attemptId: result.attemptId,
            submittedAt: result.submittedAt,
            receiptId: result.receiptId,
            aiTag: external[0].aiTag,
          })
        })
      }

      try {
        await control.command('ensureLocalModelCatalogReady', 'body', {
          timeoutMs: options.workbenchReadyTimeoutMs,
        })
        await mailbox.install(control)
        const catalog = await request('runtime.runner.catalog')
        const selectedModel = catalog.models.find(
          row => row.runtime === 'codex' && row.source !== 'cloud' && row.is_default
        )
        assert.ok(selectedModel, 'Use the actual desktop model connected to the external double')
        const model = {
          runtime: selectedModel.runtime,
          provider: selectedModel.provider,
          model_id: selectedModel.model_id,
        }
        const accountId = createHash('sha256')
          .update(JSON.stringify([ids.profile, ids.org, ids.owner]))
          .digest('hex')
        const selected = await Promise.all(
          ['direct', 'group'].map(async kind => {
            const page = await request('runtime.connections.resources', {
              providerId: PROVIDER,
              kind,
              profile: ids.profile,
              query: kind === 'group' ? 'Dots selected group' : 'Dots selected peer',
            })
            const source = page.items.find(
              item => item.id === (kind === 'group' ? ids.group : ids.peer)
            )
            assert.equal(
              source?.accountId,
              accountId,
              `Native ${kind} lookup must bind the verified organization and account`
            )
            return { ...source, policy: { automatic: true, askBeforeAct: false, immediate: true } }
          })
        )
        const enabled = await request('runtime.stand_in.personal.save', {
          userId: STORY_USER,
          settings: {
            ...original,
            primary: {
              ...original.primary,
              enabled: true,
              prompt: original.primary?.prompt ?? '',
              preferences: original.primary?.preferences ?? '',
              model,
              connections: selected,
              delegation: {
                action: 'enable',
                templates: { document: true, schedule: true, process: true },
              },
            },
          },
        })
        assert.equal(enabled.primary.delegation.authorized, true)
        assert.equal(enabled.primary.delegation.profile, ids.profile)
        assert.equal(enabled.primary.delegation.accountId, accountId)
        assert.equal(enabled.primary.delegation.organizationId, ids.org)
        await storyUntil(
          () => ['direct', 'group'].map(kind => sourceState(kind)),
          states => states.every(state => state?.checkpoint?.after && !state.error),
          timeout,
          'Both selected sources must have a first real checkpoint'
        )

        // Publish every same-conversation evidence message before any questions in this batch.
        const at = Date.now() + 500
        const positive = ['direct', 'group'].flatMap(kind =>
          Object.keys(TEMPLATE_CONTENT).flatMap(template =>
            [0, 1, 2].map(variant =>
              replyCase(`${kind}-${template}-${variant + 1}`, kind, template, at, variant)
            )
          )
        )
        const automatic = positive
          .filter(sample => sample.question.id.endsWith('-document-1'))
          .map(sample => sample.question)
        await mailbox.configureDelivery({ automatic })
        await publishCases(positive)
        await assertDelivered(positive, Math.max(timeout, BATCH_DELIVERY_TIMEOUT_MS))
        assert.equal(results.length, 18)
        assert.ok(
          (await work()).items.every(row => !row.task),
          'Automatic delivery cannot require an approval task'
        )
        assert.equal(
          Number(
            await control.command('getElementCount', '[data-testid="request-user-input-card"]')
          ),
          0
        )

        const negativeAt = Date.now() + 500
        const negative = [
          nonReplyCase('missing', 'direct', 'needs_user', '同会话没有共享过指定文档。', negativeAt),
          nonReplyCase('conflict', 'group', 'needs_user', '时间冲突，尚无最终确认。', negativeAt, [
            '培训消息一说下午两点。',
            '培训消息二说下午三点。',
          ]),
          nonReplyCase('stale', 'direct', 'needs_user', '之前的安排已经过期。', negativeAt, [
            '上个月的培训已经结束。',
          ]),
          nonReplyCase('sensitive', 'group', 'needs_user', '资料的受众权限未确认。', negativeAt, [
            '该模拟材料仅供财务小组查看。',
          ]),
          nonReplyCase(
            'commitment',
            'direct',
            'needs_user',
            '明天上线是新的承诺，需要本人决定。',
            negativeAt
          ),
          nonReplyCase(
            'permission',
            'group',
            'needs_user',
            '新增审批和资金权限需要本人决定。',
            negativeAt
          ),
          nonReplyCase('greeting', 'direct', 'skip', '你好，谢谢！', negativeAt),
        ]
        const excluded = [
          message('outside-direct', 'direct', '只有此私聊有未授权依据。', negativeAt, {
            conversationId: ids.otherDirect,
            senderId: ids.peer2,
          }),
          message('outside-group', 'group', '未选群明确 @ 本人。', negativeAt, {
            conversationId: ids.otherGroup,
          }),
          message('without-mention', 'group', '选中群未 @ 本人。', negativeAt, {
            mentioned: false,
          }),
          message('mention-other', 'group', '选中群只 @ 了其他人。', negativeAt, {
            mentioned: false,
          }),
        ]
        const forged = replyCase('forged-citation', 'direct', 'document', negativeAt)
        forged.decision.evidence = [{ messageId: excluded[0].id, quote: excluded[0].text }]
        await publishCases([...negative, forged], excluded)
        const denied = await awaitOutcomes(
          [...negative, forged].map(sample => sample.question.id),
          'complete',
          'Invalid and declined decisions must be persisted without submitting'
        )
        negative.forEach((sample, i) => {
          assert.equal(denied[i].action, sample.decision.action)
          assert.equal(denied[i].reason, sample.decision.reason)
        })
        assert.equal(denied.at(-1).action, 'needs_user')
        assert.match(denied.at(-1).reason, /No valid, shareable answer/)
        await assertSilent([...negative, forged])
        await assertSilent(excluded, { uncollected: true })
        assert.ok(
          !(await mailbox.reads()).some(row =>
            [ids.otherGroup, ids.otherDirect].includes(row.conversationId)
          )
        )

        const changed = replyCase('changed-evidence', 'group', 'schedule', Date.now() + 500)
        changed.changeBeforeRecheck = { ...changed.evidence[2], text: '地点已经改成 501 会议室。' }
        await publishCases([changed])
        const [changedResult] = await awaitOutcomes(
          [changed.question.id],
          'complete',
          'Evidence changed between decision and submission'
        )
        assert.equal(changedResult.action, 'needs_user')
        assert.match(changedResult.reason, /conversation changed/)
        await assertSilent([changed])

        await mailbox.setOffline(true)
        await Promise.all(
          ['direct', 'group'].map(kind => visibleSourceError(kind, row => row.error.code))
        )
        const recoveryAt = Date.now() + 500
        const handled = replyCase('offline-owner-handled', 'direct', 'schedule', recoveryAt)
        const unanswered = replyCase('offline-unanswered', 'group', 'process', recoveryAt)
        const ownerReply = message(
          'offline-manual-answer',
          'direct',
          '本人已经答复。',
          recoveryAt + 50,
          { senderId: ids.owner }
        )
        await publishCases([handled, unanswered], [ownerReply])
        await storyUntil(
          () => Date.now(),
          now => now > Date.parse(ownerReply.at),
          timeout,
          'Both offline messages have been posted'
        )
        await mailbox.setOffline(false)
        await storyUntil(
          () => ['direct', 'group'].map(kind => sourceState(kind)),
          states =>
            states.every(
              state =>
                !state?.error && Date.parse(state?.checkpoint?.after) >= Date.parse(ownerReply.at)
            ),
          COLLECTION_RECOVERY_WAIT_MS,
          'Both sources must complete a real collection after automatic backoff'
        )
        await assertDelivered([unanswered])
        const [handledResult] = await awaitOutcomes(
          [handled.question.id],
          'complete',
          'Owner intervention must remain authoritative after reconnect'
        )
        assert.equal(handledResult.action, 'skip')
        assert.match(handledResult.reason, /owner already responded/)
        assert.equal(decisions.has(handled.question.id), false)
        await assertSilent([handled])

        const unknown = replyCase('unknown-receipt', 'group', 'document', Date.now() + 500)
        await mailbox.setUnknownReceipt(unknown.question.id)
        await publishCases([unknown])
        const [unknownResult] = await awaitOutcomes(
          [unknown.question.id],
          'unknown',
          'A missing channel receipt cannot be marked sent'
        )
        assert.equal(unknownResult.receiptId, null)
        assert.equal(
          (await mailbox.replies()).filter(row => row.messageId === unknown.question.id).length,
          1
        )
        const executorLogPath = join(options.resultDir, 'executor.log')
        const logOffset = (await readFile(executorLogPath, 'utf8')).length
        const originalPid = await currentExecutorPid(control)
        assert.ok(originalPid, 'Recover with an actual desktop executor restart')
        process.kill(originalPid, 'SIGTERM')
        await waitForRestartedExecutor({
          control,
          originalPid,
          executorLogPath,
          logOffset,
          timeoutMs: timeout,
        })
        const followup = replyCase('receipt-followup', 'group', 'document', Date.now() + 500)
        followup.question.quotedMessageId = unknown.question.id
        const pending = replyCase('pending-task-receipt', 'group', 'document', Date.now() + 500)
        const rejected = replyCase('rejected-submit', 'direct', 'schedule', Date.now() + 500)
        await mailbox.configureDelivery({
          automatic,
          pending: pending.question,
          rejected: rejected.question,
        })
        await publishCases([followup, pending, rejected])
        const [followupResult] = await awaitOutcomes(
          [followup.question.id],
          'complete',
          'A linked follow-up cannot replay an uncertain send'
        )
        assert.equal(followupResult.action, 'skip')
        assert.equal(records().get(unknown.question.id).delegationResult.status, 'unknown')
        assert.equal(
          (await mailbox.replies()).filter(row => row.messageId === unknown.question.id).length,
          1
        )
        await assertSilent([followup])

        await Promise.all([
          awaitOutcomes([pending.question.id], 'unknown', 'Channel task must stay unconfirmed'),
          awaitOutcomes([rejected.question.id], 'failed', 'Explicit channel refusal must fail'),
        ])
        const delivery = await verifyDingTalkDelivery(control, {
          mailbox,
          work,
          automaticallyConfirmed: automatic.map(question => records().get(question.id)),
          pending: records().get(pending.question.id),
          rejected: records().get(rejected.question.id),
          timeout: options.uiTimeoutMs,
        })

        async function testRecoveryGap(kind, reason, makeGapSamples) {
          await mailbox.setOffline(true)
          await visibleSourceError(kind, row => row.error.code !== 'dingtalk_delegation_gap')
          if (reason === 'duration') {
            // Only backdate the persisted collection cursor in this isolated E2E database.
            const adjusted = db
              .prepare(
                `UPDATE loop_items SET metadata=json_set(metadata, '$.checkpoint', json(?))
              WHERE resource_type='stand_in_source' AND json_extract(metadata, '$.userId')=?
                AND json_extract(metadata, '$.source.kind')=? AND json_extract(metadata, '$.source.delegated')=1`
              )
              .run(
                JSON.stringify({
                  after: new Date(Date.now() - 31 * 60_000).toISOString(),
                  cursor: '0',
                }),
                STORY_USER,
                kind
              )
            assert.equal(adjusted.changes, 1, 'Backdate exactly one persisted cursor')
          }
          const gapSamples = makeGapSamples(Date.now() + 500)
          await publishCases(gapSamples)
          const last = Math.max(...gapSamples.map(sample => Date.parse(sample.question.at)))
          await storyUntil(
            () => Date.now(),
            now => now > last,
            timeout,
            'Finish posting the external backlog'
          )
          await mailbox.setOffline(false)
          await storyUntil(
            () => sourceState(kind),
            state => state?.delegationGap?.reason === reason,
            COLLECTION_RECOVERY_WAIT_MS,
            `Persist the skipped ${reason} gap and advance the real cursor`
          )
          await visibleSourceError(kind, row => row.error.code === 'dingtalk_delegation_gap')
          const next = replyCase(`after-gap-${reason}`, kind, 'schedule', Date.now() + 500)
          await publishCases([next])
          await assertDelivered([next])
          await assertSilent(gapSamples, { uncollected: true })
          const snapshot = await work()
          const error = snapshot.sourceErrors.find(row => row.source.kind === kind)
          assert.equal(
            error?.delegationGap?.reason,
            reason,
            'A healthy poll must preserve the gap notice'
          )
          const acknowledged = await request('runtime.stand_in.source.retry', {
            userId: STORY_USER,
            source: error.source,
          })
          assert.equal(acknowledged.success, true)
          assert.ok(!(await work()).sourceErrors.some(row => row.source.kind === kind))
        }

        await testRecoveryGap('direct', 'duration', at => [
          replyCase('old-gap', 'direct', 'document', at),
        ])
        await testRecoveryGap('group', 'volume', at =>
          Array.from({ length: 51 }, (_, index) =>
            nonReplyCase(`volume-gap-${index}`, 'group', 'skip', '测试缺口消息。', at)
          )
        )

        const before = await settings()
        await mailbox.setAccount({ userId: ids.owner, orgId: `${ids.org}-different` })
        const revoked = await storyUntil(
          settings,
          value => value.primary.delegation?.accountInvalidated === true,
          timeout,
          'An organization change must invalidate the original delegation grant'
        )
        assert.equal(revoked.primary.delegation.authorized, false)
        assert.equal(revoked.primary.delegation.paused, true)
        assert.ok(revoked.primary.delegation.version > before.primary.delegation.version)
        assert.ok(!revoked.primary.connections.some(row => row.providerId === PROVIDER))
        // Keep the same collector active through a separate, non-delegated source.
        const { items: groups } = await request('runtime.connections.resources', {
          providerId: PROVIDER,
          kind: 'group',
          query: 'Dots excluded group',
        })
        const probe = groups.find(row => row.id === ids.otherGroup)
        assert.ok(probe?.accountId, 'Find the control group under the switched account')
        assert.notEqual(probe.accountId, before.primary.delegation.accountId)
        await request('runtime.stand_in.personal.save', {
          userId: STORY_USER,
          settings: {
            ...revoked,
            roles: [
              ...revoked.roles,
              {
                id: COLLECTION_PROBE_ROLE,
                name: 'Account switch collection probe',
                enabled: true,
                prompt: '',
                tags: [],
                executionDeviceId: revoked.executionDeviceId,
                version: 0,
                collaboration: {
                  enabled: false,
                  allProjects: false,
                  projects: [],
                  excludedProjects: [],
                  tags: [],
                },
                connections: [{ ...probe, policy: { automatic: false, askBeforeAct: true } }],
              },
            ],
          },
        })
        const afterChange = replyCase('prior-account', 'group', 'process', Date.now() + 500)
        await publishCases([afterChange])
        const probeCheckpointAfter = (at, label) =>
          storyUntil(
            () => sourceState('group', ids.otherGroup),
            state => !state?.error && Date.parse(state?.checkpoint?.after) > Date.parse(at),
            COLLECTION_RECOVERY_WAIT_MS,
            label
          )
        const probePoll = await probeCheckpointAfter(
          afterChange.question.at,
          'The switched account must collect after the old-account message was published'
        )
        // Assistant sweeps never overlap. A second probe poll proves the first sweep finished.
        const completedPoll = await probeCheckpointAfter(
          probePoll.checkpoint.after,
          'The preceding post-switch collection sweep must finish before checking silence'
        )
        assert.equal((await settings()).primary.delegation.authorized, false)
        await assertSilent([afterChange], { uncollected: true })
        const readsAfterSwitch = (await mailbox.reads()).filter(
          row => Date.parse(row.end) >= Date.parse(afterChange.question.at)
        )
        assert.ok(readsAfterSwitch.some(row => row.conversationId === ids.otherGroup))
        assert.ok(!readsAfterSwitch.some(row => row.conversationId === ids.group))

        await writeFile(
          join(options.resultDir, 'dingtalk-delegation-evidence.json'),
          JSON.stringify(
            {
              modelBoundary: 'synthetic structured decisions',
              channelBoundary: 'native DingTalk CLI protocol fixture',
              results,
              delivery,
              negatives: [
                ...negative.map((sample, index) => ({
                  id: sample.question.id,
                  action: denied[index].action,
                  reason: denied[index].reason,
                })),
                {
                  id: forged.question.id,
                  action: denied.at(-1).action,
                  reason: denied.at(-1).reason,
                },
                {
                  id: changed.question.id,
                  action: changedResult.action,
                  reason: changedResult.reason,
                },
                ...excluded.map(item => ({ id: item.id, action: 'uncollected' })),
              ],
              recovery: {
                ownerIntervention: handledResult.action,
                ambiguousReceipt: unknownResult.status,
                linkedFollowup: followupResult.action,
                gaps: ['duration', 'volume'],
                accountInvalidated: true,
                accountSwitchCollection: {
                  publishedAt: afterChange.question.at,
                  firstCheckpoint: probePoll.checkpoint.after,
                  nextCheckpoint: completedPoll.checkpoint.after,
                },
              },
            },
            null,
            2
          )
        )
      } finally {
        db.close()
        await mailbox.setOffline(false)
        await mailbox.setAccount({ userId: ids.owner, orgId: ids.org })
        const current = await settings()
        await request('runtime.stand_in.personal.save', {
          userId: STORY_USER,
          settings: { ...original, version: current.version },
        })
      }
    },
  }
}
