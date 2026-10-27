import assert from 'node:assert/strict'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestContainsSkillLocator } from './desktop-server.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { managedRoot } from './managed-plugin-root.mjs'
import { testId, until } from './plugin-regression-fixture.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from './response-protocol.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from './shared.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'

function latestSkillCatalog(body) {
  const texts = typeof body.instructions === 'string' ? [body.instructions] : []
  for (const message of body.input ?? []) {
    if (!['developer', 'system', 'user'].includes(message.role)) continue
    if (typeof message.content === 'string') texts.push(message.content)
    else {
      for (const content of message.content ?? []) {
        if (typeof content.text === 'string') texts.push(content.text)
      }
    }
  }
  const catalogs = texts.flatMap(text =>
    [...text.matchAll(/<skills_instructions>([\s\S]*?)<\/skills_instructions>/gu)].map(
      match => match[1]
    )
  )
  const catalog = catalogs.at(-1)
  assert.ok(catalog?.trim(), 'The real model request has no current skill instructions')
  // An empty host-skills update supersedes earlier catalogs too.
  return catalog
}

export function createPluginSkillHotUpdate({
  executorHome,
  resultDir,
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  let fixture
  let skillPath
  let address
  let identity
  let processStarts
  let executorOrigin
  let pending = null
  let round = 0
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const readStarts = async () => {
    const log = await readFile(join(resultDir, 'executor.log'), 'utf8')
    return [...log.matchAll(/codex shared app-server process starting process_id=(\d+)/g)].map(
      match => match[1]
    )
  }

  async function recordCatalogFailure(catalog, advertised) {
    const diagnostic = {
      round,
      expectedEnabled: pending.enabled,
      advertised,
      expectedSkillName: `${fixture.slug}:${fixture.slug}`,
      expectedSkillPath: skillPath,
      latestSkillsInstructions: catalog,
    }
    try {
      // The UI can be waiting for this model response, so use the known origin
      // without queuing another renderer command behind that wait.
      const response = await fetch(`${executorOrigin}/wework/executor/v1/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `skill-hot-update-diagnostic-${round}`,
          method: 'runtime.codex.app_server.request',
          params: {
            method: 'skills/list',
            params: { cwds: [address?.workspacePath ?? workspacePath], forceReload: false },
          },
        }),
        signal: AbortSignal.timeout(uiTimeoutMs),
      })
      const payload = await response.json()
      assert.ok(response.ok && payload.ok, `Native skill catalog failed: HTTP ${response.status}`)
      diagnostic.nativeCatalog = payload.result.data.map(entry => ({
        cwd: entry.cwd,
        skills: entry.skills.map(({ name, path, enabled }) => ({ name, path, enabled })),
      }))
    } catch (error) {
      diagnostic.nativeCatalogError = error.message
    }
    await writeFile(
      join(resultDir, `skill-hot-update-catalog-failure-${round}.json`),
      JSON.stringify(diagnostic, null, 2)
    )
  }

  async function assertCatalog(control, enabled) {
    const catalog = await rpc(control, 'runtime.codex.app_server.request', {
      method: 'skills/list',
      params: { cwds: [address.workspacePath], forceReload: false },
    })
    const skill = catalog.data
      .flatMap(entry => entry.skills)
      .find(item => item.name === `${fixture.slug}:${fixture.slug}`)
    assert.ok(skill, 'The real Codex skill catalog lost the installed skill')
    assert.equal(await realpath(skill.path), await realpath(skillPath))
    assert.equal(skill.enabled, enabled, 'The real Codex skill enabled state is stale')
  }

  function releasePending() {
    pending?.release?.()
    pending = null
  }

  async function openConversation(control) {
    await control.command('navigate', 'body', { value: '/' })
    await control.command('click', testId(`runtime-local-task-row-${identity.taskId}`))
    await waitForWorkbenchDebugState(
      control,
      state => state.workbench?.currentRuntimeTask?.taskId === identity.taskId,
      'The original skill hot update conversation did not reopen'
    )
  }

  async function beginTurn(control, enabled, held = false) {
    assert.equal(pending, null, 'The previous skill hot update turn is still pending')
    round += 1
    pending = {
      prompt: `WEWORK_SKILL_HOT_UPDATE_${round}`,
      completion: held
        ? `WEWORK_SKILL_HOT_UPDATE_RUNNING_${round} complete`
        : `WEWORK_SKILL_HOT_UPDATE_DONE_${round}`,
      partial: `WEWORK_SKILL_HOT_UPDATE_RUNNING_${round}`,
      enabled,
      held,
      observed: false,
    }
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: pending.prompt })
    await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR)
  }

  async function finishTurn(control, checkCatalog = true) {
    try {
      await control.command('waitFor', testId('message-assistant'), {
        text: pending.completion,
        timeoutMs: modelResponseTimeoutMs,
      })
      const debug = await waitForWorkbenchDebugState(
        control,
        state => state.pane?.status?.isBusy === false && state.workbench?.currentRuntimeTask,
        'The skill hot update conversation did not finish'
      )
      const currentAddress = debug.workbench.currentRuntimeTask
      const { task } = await rpc(control, 'runtime.tasks.get', { address: currentAddress })
      assert.ok(task.threadId, 'The skill hot update task has no real Codex thread')
      const current = { taskId: task.taskId, threadId: task.threadId }
      if (identity) assert.deepEqual(current, identity, 'Skill toggling replaced the conversation')
      else {
        identity = current
        address = currentAddress
      }
      assert.equal(pending.observed, true, 'The real model did not receive the expected turn')
      // Observe the actual turn before reading the catalog; this read must not force a reload.
      if (checkCatalog) await assertCatalog(control, pending.enabled)
      const starts = await readStarts()
      assert.ok(starts.length > 0, 'The executor did not log a real Codex process')
      if (processStarts)
        assert.deepEqual(starts, processStarts, 'Skill toggling restarted the shared Codex process')
      else processStarts = starts
    } finally {
      releasePending()
    }
  }

  async function sendTurn(control, enabled) {
    await beginTurn(control, enabled)
    await finishTurn(control)
  }

  async function assertHeldTurn(control) {
    assert.equal(pending?.held, true, 'The model response is not being held')
    assert.equal(pending.observed, true, 'The held model request did not start')
    assert.equal(pending.cancelled, false, 'Skill toggling cancelled the active model response')
    assert.equal(pending.response.destroyed, false, 'The active model response disconnected')
    assert.equal(pending.response.writableEnded, false, 'The held model response ended early')
    const { task } = await rpc(control, 'runtime.tasks.get', { address })
    assert.equal(task.running, true, 'Skill toggling stopped the running task')
    assert.deepEqual({ taskId: task.taskId, threadId: task.threadId }, identity)
    assert.deepEqual(await readStarts(), processStarts, 'Skill toggling restarted active Codex')
  }

  return {
    async handleHttp(request, response, url) {
      if (!pending || request.method !== 'POST') return false
      if (!['/responses', '/v1/responses'].includes(url.pathname)) return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body.input ?? []).includes(pending.prompt)) return false
      const turn = pending
      assert.equal(turn.observed, false, 'The skill hot update turn made a duplicate model request')
      const catalog = latestSkillCatalog(body)
      const advertised = requestContainsSkillLocator(
        { instructions: catalog },
        skillPath,
        fixture.slug
      )
      if (advertised !== pending.enabled) await recordCatalogFailure(catalog, advertised)
      assert.equal(
        advertised,
        pending.enabled,
        'The loaded conversation advertised a stale skill catalog on its next turn'
      )
      pending.observed = true
      const stream = streamingTextEvents(
        `skill-hot-update-${round}`,
        pending.completion,
        'final_answer'
      )
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (turn.held) {
        turn.response = response
        turn.cancelled = false
        turn.release = () => {
          turn.released = true
          if (!response.destroyed && !response.writableEnded) {
            response.end(createSse(stream.finish))
          }
        }
        response.once('close', () => {
          if (!turn.released) turn.cancelled = true
        })
        response.flushHeaders()
        response.write(
          createSse([
            ...stream.start,
            {
              type: 'response.output_text.delta',
              item_id: stream.itemId,
              output_index: 0,
              content_index: 0,
              delta: turn.partial,
            },
          ])
        )
      } else response.end(createSse([...stream.start, ...stream.finish]))
      return true
    },
    async start(control, installedFixture) {
      fixture = installedFixture
      executorOrigin = await control.command('getLocationOrigin', 'body')
      const root = await until(
        () => managedRoot(executorHome, fixture.installedId),
        Boolean,
        'The real plugin package was not materialized'
      )
      skillPath = join(root, 'skills', fixture.slug, 'SKILL.md')
      await control.command('navigate', 'body', { value: '/' })
      await createSingleRootLocalProject(control, workspacePath, 'skill-hot-update')
      await selectE2EModel(control)
      await sendTurn(control, true)
    },
    async hold(control, enabled) {
      await openConversation(control)
      await beginTurn(control, enabled, true)
      await control.command('waitFor', testId('message-assistant'), {
        text: pending.partial,
        timeoutMs: modelResponseTimeoutMs,
      })
      await assertHeldTurn(control)
    },
    async verify(control, enabled) {
      if (pending?.held) await assertHeldTurn(control)
      await openConversation(control)
      if (pending?.held) {
        await assertHeldTurn(control)
        pending.release()
        await finishTurn(control, false)
      }
      await sendTurn(control, enabled)
    },
    cleanup: releasePending,
  }
}
