import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
    const child =
      cell.mode === 'coordinate' &&
      (cell.runtime === 'codex'
        ? isCollaborationSubagentRequest(headers)
        : input.includes(cell.assignment) && !input.includes(cell.prompt))
    if (
      child ||
      (cell.mode === 'pipeline' && request.includes(cell.second) && input.includes(cell.handoff))
    ) {
      assert.ok(
        request.includes(cell.second),
        'Second Bot instructions must reach its own native turn'
      )
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
    const evidence = []
    const cells = []
    const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
    const catalog = await rpc('runtime.runner.catalog', {})
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
      const model =
        catalog.models.find(row => row.runtime === runtime && row.is_default) ??
        catalog.models.find(row => row.runtime === runtime)
      assert.ok(model, 'Missing personal assistant model for ' + runtime)
      for (const mode of ['solo', 'pipeline', 'coordinate']) {
        const id = 'personal-' + runtime.replace('_', '-') + '-' + mode
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
        const saved = await rpc('runtime.stand_in.personal.save', {
          userId,
          transferRoleId: id,
          settings: { ...settings, roles: [...settings.roles, role] },
          portableTeam: {
            name: id,
            bot: bots,
            collaboration_model: mode,
            model_policy: {
              mode: 'fixed',
              model: { runtime, provider: model.provider, model_id: model.model_id },
            },
          },
        })
        const teamRef = saved.roles.find(row => row.id === id)?.teamRef
        assert.ok(teamRef)
        cells.push({ ...definition, teamRef })
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
      await control.command('clickWhenEnabled', chat + ' [data-testid="send-message-button"]')
      await control.command('waitFor', chat + ' [data-testid="message-assistant"]', {
        text: cell.result,
        timeoutMs: 60000,
      })
      if (mode !== 'solo') assert.ok(cell.reviewed, 'The worker Bot must execute before delivery')
      await captureScreenshot(control, id + '-delivery.png', chat)
      const taskId = `stand-in-chat-${userId}-role-${id}`
      const { task } = await rpc('runtime.tasks.get', { taskId })
      assert.equal(task.taskId, taskId)
      assert.equal(task.runtime, runtime)
      evidence.push({
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
