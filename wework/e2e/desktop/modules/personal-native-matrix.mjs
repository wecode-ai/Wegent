import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkPersonalBotTurn,
  installPersonalBotCapability,
  startPersonalBotProbe,
} from './personal-bot-capabilities.mjs'
import { isCollaborationSubagentRequest } from './subagent-request.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { standInRoleFixture } from './stand-in-role-fixture.mjs'
import { finishStandInOnboarding } from './stand-in-instance-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import {
  isReplyPredictionRequest,
  selectTool,
  selectedToolCall,
  createSse,
  responseCreated,
  responseCompleted,
} from './response-protocol.mjs'

export function personalNativeMatrix({
  captureScreenshot,
  resultDir,
  uiTimeoutMs,
  writeText,
  writeToolCall,
}) {
  let cell
  function handleModel(body, response, headers) {
    if (!cell || isReplyPredictionRequest(body)) return false
    const input = JSON.stringify(body.input ?? [])
    const instructions = JSON.stringify(body.instructions ?? '')
    const request = JSON.stringify(body)
    if (!request.includes(cell.id)) return false
    cell.modelCalls++
    assert.ok(!cell.denied, 'Unequal native Coordinate grants reached the model')
    const child =
      cell.mode === 'coordinate' &&
      (cell.runtime === 'codex'
        ? isCollaborationSubagentRequest(headers)
        : input.includes(cell.assignment) && !input.includes(cell.prompt))
    const reviewer =
      child ||
      (cell.mode === 'pipeline' && request.includes(cell.second) && input.includes(cell.handoff))
    assert.ok(request.includes(reviewer ? cell.second : cell.first), 'Unexpected Bot instructions')
    if (checkPersonalBotTurn({ cell, reviewer, body, headers, response, writeToolCall }))
      return true
    if (reviewer) {
      cell.reviewed = true
      writeText(response, cell.id + '-second', child ? cell.handoff : cell.result)
    } else if (cell.mode === 'coordinate' && !input.includes(cell.handoff)) {
      const spawn = !cell.spawned
      cell.spawned = true
      if (cell.runtime === 'claude_code') {
        assert.ok(spawn, 'Claude Agent must return the worker result to the manager')
        const name = body.tools.find(tool => ['Agent', 'Task'].includes(tool.name))?.name
        assert.ok(name, 'Claude must advertise the native delegation tool')
        writeToolCall(response, cell.id, cell.id + '-delegate', name, {
          description: 'Review delivery',
          subagent_type: 'reviewer-2',
          prompt: cell.assignment,
        })
      } else {
        const tool = spawn
          ? selectTool(body, 'spawn_agent', {
              task_name: 'review',
              agent_type: 'reviewer-2',
              fork_turns: 'none',
              message: cell.assignment,
            })
          : selectTool(body, 'wait_agent', { timeout_ms: 30000 })
        const id = cell.id + '-' + ++cell.calls
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          createSse([responseCreated(id), ...selectedToolCall(id, tool), responseCompleted(id)])
        )
      }
    } else {
      assert.ok(
        instructions.includes(cell.first) || input.includes(cell.first),
        'The saved lead Bot must run'
      )
      writeText(response, cell.id + '-lead', cell.mode === 'pipeline' ? cell.handoff : cell.result)
    }
    return true
  }

  async function verify(control, cloud) {
    const user = await fetch(cloud.backendUrl + '/api/users/me', {
      headers: { Authorization: 'Bearer ' + cloud.authToken },
    })
    assert.ok(user.ok)
    const userId = (await user.json()).id
    const probe = await startPersonalBotProbe(resultDir)
    try {
      const capabilities = await Promise.all(
        [1, 2].map(slot => installPersonalBotCapability(cloud, resultDir, slot, probe))
      )
      await verifyMatrix(control, cloud, userId, capabilities, probe)
    } finally {
      await probe.close()
    }
  }

  async function verifyMatrix(control, cloud, userId, capabilities, probe) {
    const evidence = []
    const cells = []
    const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
    const catalog = await rpc('runtime.runner.catalog', {})
    const models = await fetch(
      cloud.backendUrl +
        '/api/models/unified?scope=all&include_config=false&model_category_type=llm&client_origin=wework',
      { headers: { Authorization: 'Bearer ' + cloud.authToken } }
    )
    assert.ok(models.ok, 'The signed-in user must be able to list cloud models')
    const candidates = (await models.json()).data.filter(
      row => row.type === 'public' && row.name === 'desktop-e2e-cloud-responses'
    )
    assert.equal(candidates.length, 1, 'Expected one seeded public Responses model')
    const [model] = candidates
    assert.ok(model.namespace && model.resourceUserId != null && model.isActive !== false)
    const profile = await rpc('runtime.stand_in.personal.get', { userId })
    const deviceId = profile.executionDeviceId
    const binding = await rpc('runtime.stand_in.binding', { operation: 'get' })
    await rpc('runtime.stand_in.binding', {
      operation: 'bind',
      version: binding.version,
      target: { userId, deviceId, backendUrl: cloud.backendUrl },
    })
    await rpc('runtime.stand_in.personal.lifecycle', { userId, operation: 'start' })
    await ensureExperimentalFeaturesEnabled(control)
    for (const [runtime, shell] of [
      ['codex', 'Codex'],
      ['claude_code', 'ClaudeCode'],
    ]) {
      assert.ok(catalog.runtimes.includes(runtime), 'Missing installed harness: ' + runtime)
      for (const variant of ['solo', 'pipeline', 'coordinate', 'coordinate-denied']) {
        const denied = variant === 'coordinate-denied'
        const mode = denied ? 'coordinate' : variant
        const id = 'personal-' + runtime.replace('_', '-') + '-' + variant
        const definition = {
          id,
          runtime,
          mode,
          first: id + ' lead instructions',
          second: id + ' reviewer instructions',
          prompt: id + ' prepare release',
          assignment: id + ' delegated review',
          handoff: id + ' verified evidence',
          result: id + ' complete',
          calls: 0,
          modelCalls: 0,
          capabilities,
          denied,
          probe,
          observed: {},
        }
        const settings = await rpc('runtime.stand_in.personal.get', { userId })
        const role = {
          ...standInRoleFixture(settings.executionDeviceId, id),
          name: id,
          migrationSource: JSON.stringify(['source-device', userId, id]),
        }
        const bots = [
          {
            id: 1,
            name: 'leader',
            role: 'leader',
            system_prompt: definition.first,
            shell_type: shell,
            requireConfirmation: false,
            contextPassing: 'previous_bot',
          },
        ]
        if (mode !== 'solo')
          bots.push({
            id: 2,
            name: 'reviewer',
            role: 'worker',
            shell_type: shell,
            system_prompt: definition.second,
            description: 'Check the delivery',
          })
        const team = {
          name: id,
          bot: bots,
          collaboration_model: mode,
          model_policy: {
            mode: 'fixed',
            model: {
              runtime,
              provider: model.provider || 'openai-responses',
              model_id: model.modelId || model.name,
              source: 'cloud',
              cloud_model: {
                type: model.type,
                name: model.name,
                namespace: model.namespace,
                resource_user_id: model.resourceUserId,
              },
            },
          },
        }
        const saved = await rpc('runtime.stand_in.personal.save', {
          userId,
          transferRoleId: id,
          settings: { ...settings, roles: [...settings.roles, role] },
          portableTeam: team,
        })
        const teamRef = saved.roles.find(row => row.id === id)?.teamRef
        assert.ok(teamRef)
        const { portableTeam } = await rpc('runtime.stand_in.personal.get', {
          userId,
          exportTeamRoleId: id,
        })
        const boundBots = portableTeam.bot.map(({ id, name, role }) => ({ id, name, role }))
        assert.deepEqual(
          boundBots,
          bots.map(({ id, name, role }) => ({ id, name, role }))
        )
        const provisioned = await rpc('runtime.stand_in.personal.save', {
          userId,
          settings: saved,
          ownedTeam: {
            roleId: id,
            botGrants: bots.map((bot, index) => ({
              id: bot.id,
              ...capabilities[mode === 'pipeline' || denied ? index : 0].grants,
            })),
          },
        })
        assert.equal(provisioned.roles.find(row => row.id === id)?.teamRef, teamRef)
        cells.push({ ...definition, teamRef, boundBots })
      }
    }
    await control.command('navigate', 'body', {
      value: '/stand-in?deviceId=' + encodeURIComponent(deviceId),
    })
    await control.command(
      'clickWhenEnabled',
      '[data-testid="personal-assistant-account-migrate-confirm"]'
    )
    await control.command('waitFor', '[data-testid="stand-in-overview"]')
    await finishStandInOnboarding(control)
    for (const configured of cells) {
      cell = configured
      const { id, runtime, mode, teamRef } = configured
      await control.command('clickWhenEnabled', '[data-testid="stand-in-overview-role-' + id + '"]')
      const chat =
        '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-conversation"]'
      await control.command('fill', chat + ' [data-testid="chat-message-input"]', {
        value: cell.prompt,
      })
      await captureScreenshot(control, id + '-entry.png', chat)
      const initialReceipts = probe.receipts.length
      await control.command('clickWhenEnabled', chat + ' [data-testid="send-message-button"]')
      const taskId = `stand-in-chat-${userId}-role-${id}`
      if (cell.denied) {
        const reason = 'native subagents cannot isolate distinct Bot tool grants'
        await control.command('waitFor', chat, { text: reason, timeoutMs: 30000 })
        await captureScreenshot(control, id + '-denied.png', chat)
        assert.equal(cell.modelCalls, 0)
        assert.equal(probe.receipts.length, initialReceipts)
        const { task } = await rpc('runtime.tasks.get', { taskId })
        assert.equal(task.taskId, taskId)
        evidence.push({
          taskId: task.taskId,
          boundBots: cell.boundBots,
          teamRef,
          runtime,
          mode,
          reason,
          outcome: 'denied',
          mcpCalls: 0,
          modelCalls: cell.modelCalls,
        })
        await writeFile(
          join(resultDir, 'personal-native-execution.json'),
          JSON.stringify(evidence, null, 2)
        )
        cell = null
        continue
      }
      await control.command('waitFor', chat + ' [data-testid="message-assistant"]', {
        text: cell.result,
        timeoutMs: 60000,
      })
      if (mode !== 'solo') assert.ok(cell.reviewed, 'The worker Bot must execute before delivery')
      await captureScreenshot(control, id + '-delivery.png', chat)
      const { task } = await rpc('runtime.tasks.get', { taskId })
      assert.equal(task.taskId, taskId)
      assert.equal(task.runtime, runtime)
      assert.deepEqual(Object.keys(cell.observed), mode === 'solo' ? ['1'] : ['1', '2'])
      const observed = Object.values(cell.observed)
      assert.deepEqual(
        observed.map(row => row.receipt).sort(),
        probe.receipts
          .slice(initialReceipts)
          .map(row => row.receipt)
          .sort()
      )
      evidence.push({
        boundBots: cell.boundBots,
        botCapabilities: Object.values(cell.observed),
        taskId: task.taskId,
        teamRef,
        mode,
        runtime: task.runtime,
        result: cell.result,
      })
      await writeFile(
        join(resultDir, 'personal-native-execution.json'),
        JSON.stringify(evidence, null, 2)
      )
      cell = null
    }
  }
  return { handleModel, verify }
}
