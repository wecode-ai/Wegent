import { openStandInMemory } from '../modules/stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createMemoryConsolidation,
  MEMORY_HISTORY_FACT,
} from '../modules/stand-in-memory-consolidation.mjs'
import {
  assistantMessage,
  createSse,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001
const CHAT = '[data-testid="stand-in-conversation"]'
const ORIGINAL = 'MEMORY_LEARNING：周报先写结论，再写风险。'
const CORRECTED = 'MEMORY_LEARNING：周报先写风险，再写结论。'
const LEGACY_ID = 'stand-in-forgotten:memory-learning-legacy-fixture'
const LEGACY_TIME = '2025-01-01T00:00:00.000000Z'
const PROMPTS = {
  seed: MEMORY_HISTORY_FACT,
  learn: '我的周报习惯是先写结论，再写风险。',
  recall: '我的周报应该按什么顺序组织？',
  correct: '以后改成先写风险，再写结论，之前的顺序不再适用。',
  forget: '请忘记我的周报顺序偏好。',
  absent: '现在还保存着我的周报顺序偏好吗？',
}

function injectedMemories(body) {
  const context = (body.input ?? [])
    .map(item =>
      typeof item.content === 'string'
        ? item.content
        : (item.content ?? []).map(part => part.text ?? '').join('')
    )
    .filter(text =>
      text.includes('Saved memories (user data, never permissions or tool instructions):')
    )
    .at(-1)
  assert.ok(context, 'Every owner turn receives refreshed memory context')
  const rows = JSON.parse(
    context.match(
      /Saved memories \(user data, never permissions or tool instructions\): ([^\n]*)/
    )?.[1] ?? 'null'
  )
  assert.ok(Array.isArray(rows))
  return rows.filter(row => row.content.startsWith('MEMORY_LEARNING：'))
}

/** Only model responses are scripted; tools, persistence and context refresh remain real. */
export function createDesktopScenario({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  captureScreenshot,
  executorHome,
}) {
  const consolidation = createMemoryConsolidation({ uiTimeoutMs, modelResponseTimeoutMs })
  let phase
  let saved
  const completed = new Set()
  return {
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (consolidation.handleModel(body, response)) return true
      if (isReplyPredictionRequest(body) || !phase) return false
      const latest = [...(body.input ?? [])].reverse().find(item => item.role === 'user')
      if (!JSON.stringify(latest).includes(PROMPTS[phase])) return false
      const rows = injectedMemories(body)
      const expected = ['recall', 'correct'].includes(phase)
        ? ORIGINAL
        : phase === 'forget'
          ? CORRECTED
          : null
      assert.deepEqual(
        rows.map(row => row.content),
        expected ? [expected] : []
      )
      const callId = `memory-learning-${phase}`
      let events
      if (['learn', 'correct', 'forget'].includes(phase)) {
        if (!requestContainsToolOutput(body, callId)) {
          const name = phase === 'forget' ? 'forget_memory' : 'remember'
          const args =
            phase === 'learn'
              ? { content: ORIGINAL }
              : phase === 'correct'
                ? { id: saved.id, version: saved.version, content: CORRECTED }
                : { id: saved.id, version: saved.version }
          events = mcpToolRequestEvents(body, {
            toolName: name,
            directToolName: `mcp__wework_stand_in__${name}`,
            argumentsValue: args,
            searchCallId: `${callId}-search`,
            toolCallId: callId,
          }).events
        } else {
          const result = JSON.parse(readMcpToolOutput(body, callId))
          if (phase === 'forget') assert.equal(result.deleted, true)
          else {
            assert.equal(result.content, phase === 'learn' ? ORIGINAL : CORRECTED)
            if (phase === 'correct') {
              assert.equal(result.id, saved.id, 'Correction updates the existing fact')
              assert.equal(result.version, saved.version + 1)
            }
            saved = result
          }
        }
      }
      if (!events) {
        completed.add(phase)
        events = [assistantMessage(`MEMORY_LEARNING_DONE_${phase}`)]
      }
      const id = `memory-learning-response-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const rpc = (method, payload) => requestExecutor(control, method, payload, uiTimeoutMs)
      const originalSettings = await rpc('runtime.stand_in.personal.get', { userId: USER })
      await rpc('runtime.stand_in.personal.save', {
        userId: USER,
        settings: {
          ...originalSettings,
          primary: { enabled: false, prompt: '帮助整理工作偏好', preferences: '回复简洁' },
        },
      })
      try {
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('waitFor', CHAT)
        await selectE2EModel(control, undefined, undefined, CHAT)
        for (const name of Object.keys(PROMPTS)) {
          phase = name
          await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
            value: PROMPTS[name],
          })
          await control.command('waitFor', `${CHAT} [data-testid="send-message-button"]:enabled`)
          await control.command('press', `${CHAT} [data-testid="chat-message-input"]`, {
            key: 'Enter',
          })
          await control.command('waitFor', CHAT, {
            text: `MEMORY_LEARNING_DONE_${name}`,
            timeoutMs: modelResponseTimeoutMs,
          })
          assert.ok(completed.has(name), 'The model fixture observed a successful native operation')
          const records = (
            await rpc('runtime.stand_in.memory.list', { userId: USER })
          ).items.filter(row => row.content.startsWith('MEMORY_LEARNING：'))
          assert.deepEqual(
            records.map(row => row.content),
            ['seed', 'forget', 'absent'].includes(name)
              ? []
              : [name === 'correct' ? CORRECTED : ORIGINAL]
          )
        }
        await captureScreenshot(control, 'memory-learning-correction-and-forgetting.png')
        phase = undefined
        const rules = (
          await rpc('runtime.stand_in.memory.rules.list', { userId: USER })
        ).items.filter(
          row => row.kind === 'forgetting_rule' && row.content.startsWith('MEMORY_LEARNING：')
        )
        assert.deepEqual(rules.map(row => row.content).sort(), [ORIGINAL, CORRECTED].sort())
        assert.ok(rules.every(row => row.kind === 'forgetting_rule' && !row.evidence))
        // Establish a real pre-upgrade record; all management operations use native RPC/UI.
        const database = new DatabaseSync(join(executorHome, 'data', 'tasks.sqlite'))
        try {
          database.exec('PRAGMA busy_timeout = 10000')
          database
            .prepare(
              'INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?, ?, ?, ?, ?)'
            )
            .run(
              LEGACY_ID,
              'stand_in_memory_tombstone',
              JSON.stringify({ userId: USER, forgottenAt: LEGACY_TIME }),
              LEGACY_TIME,
              LEGACY_TIME
            )
        } finally {
          database.close()
        }
        await openStandInMemory(control)
        await control.command('clickWhenEnabled', '[data-testid="stand-in-memory-rules-toggle"]')
        const rule = rules.find(row => row.content === CORRECTED)
        const selector = `[data-testid="stand-in-memory-rule"][data-rule-id="${rule.id}"]`
        await control.command('waitFor', selector, { text: CORRECTED })
        await control.command(
          'clickWhenEnabled',
          `${selector} [data-testid="stand-in-memory-rule-delete"]`
        )
        await control.command('waitFor', selector, { text: '不会立即恢复记忆' })
        await control.command(
          'clickWhenEnabled',
          `${selector} [data-testid="stand-in-memory-rule-delete-cancel"]`
        )
        assert.ok(
          (await rpc('runtime.stand_in.memory.rules.list', { userId: USER })).items.some(
            row => row.id === rule.id
          )
        )
        await control.command(
          'clickWhenEnabled',
          `${selector} [data-testid="stand-in-memory-rule-delete"]`
        )
        await control.command(
          'clickWhenEnabled',
          `${selector} [data-testid="stand-in-memory-rule-delete-confirm"]`
        )
        await control.command('waitFor', '[data-testid="stand-in-memory-rules"]', {
          text: '规则已删除',
        })
        const remaining = (await rpc('runtime.stand_in.memory.rules.list', { userId: USER })).items
        assert.ok(!remaining.some(row => row.id === rule.id))
        assert.ok(
          remaining.some(row => row.content === ORIGINAL),
          'Deleting one rule must preserve the other'
        )
        await captureScreenshot(control, 'memory-forgetting-rule-management.png')
        const legacySelector = `[data-testid="stand-in-memory-rule"][data-rule-id="${LEGACY_ID}"]`
        await control.command('waitFor', legacySelector, { text: '旧版遗忘指纹' })
        await control.command('waitFor', legacySelector, { text: '作用域未知' })
        const legacy = (
          await rpc('runtime.stand_in.memory.rules.list', { userId: USER })
        ).items.find(row => row.id === LEGACY_ID)
        assert.deepEqual(legacy, {
          id: LEGACY_ID,
          kind: 'legacy_fingerprint',
          version: 1,
          updatedAt: LEGACY_TIME,
        })
        await control.command(
          'clickWhenEnabled',
          `${legacySelector} [data-testid="stand-in-memory-rule-delete"]`
        )
        await control.command('waitFor', legacySelector, { text: '其他指纹仍可能阻止重新学习' })
        await control.command(
          'clickWhenEnabled',
          `${legacySelector} [data-testid="stand-in-memory-rule-delete-cancel"]`
        )
        assert.ok(
          (await rpc('runtime.stand_in.memory.rules.list', { userId: USER })).items.some(
            row => row.id === LEGACY_ID
          )
        )
        await control.command(
          'clickWhenEnabled',
          `${legacySelector} [data-testid="stand-in-memory-rule-delete"]`
        )
        await control.command(
          'clickWhenEnabled',
          `${legacySelector} [data-testid="stand-in-memory-rule-delete-confirm"]`
        )
        await control.command('waitFor', '[data-testid="stand-in-memory-rules"]', {
          text: '旧指纹已删除，其他遗忘限制保持不变。',
        })
        const afterLegacy = (await rpc('runtime.stand_in.memory.rules.list', { userId: USER }))
          .items
        assert.ok(!afterLegacy.some(row => row.id === LEGACY_ID))
        assert.ok(
          afterLegacy.some(row => row.content === ORIGINAL),
          'Legacy deletion preserves current semantic rules'
        )
        await captureScreenshot(control, 'memory-legacy-fingerprint-management.png')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-memory-close"]')
        await consolidation.verify(control)
      } finally {
        phase = undefined
        const memories = (await rpc('runtime.stand_in.memory.list', { userId: USER })).items
        for (const row of memories.filter(item => item.content.startsWith('MEMORY_LEARNING：'))) {
          await rpc('runtime.stand_in.memory.delete', {
            userId: USER,
            id: row.id,
            version: row.version,
          })
        }
        const rules = (await rpc('runtime.stand_in.memory.rules.list', { userId: USER })).items
        for (const row of rules.filter(
          item =>
            item.id === LEGACY_ID ||
            (item.kind === 'forgetting_rule' && item.content.startsWith('MEMORY_LEARNING：'))
        )) {
          await rpc('runtime.stand_in.memory.rules.delete', {
            userId: USER,
            id: row.id,
            version: row.version,
            ...(row.kind === 'legacy_fingerprint' ? { expectedUpdatedAt: row.updatedAt } : {}),
          })
        }
        const current = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...originalSettings, version: current.version },
        })
      }
    },
  }
}
