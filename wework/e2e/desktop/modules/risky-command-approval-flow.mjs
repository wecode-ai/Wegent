import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assistantMessage,
  requestAdvertisesShellTool,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'
import { shellCommandResponse } from './shell-command-response.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  DEFAULT_STEP_TIMEOUT_MS,
  assert,
  sendPromptUntilScenarioRequest,
} from './shared.mjs'

export const RISKY_COMMAND_APPROVAL_SCENARIOS = ['risky_command_manual', 'risky_command_automatic']
const fixture = scenario => `${scenario}.tmp`
const prompt = scenario => `Remove the isolated ${fixture(scenario)} test file.`
const completion = scenario => `Finished checking ${fixture(scenario)}.`

export function handleRiskyCommandApproval(server, body, response, id, modelRequest) {
  const scenario = server.scenario
  if (!RISKY_COMMAND_APPROVAL_SCENARIOS.includes(scenario)) return false

  const events = [responseCreated(id)]
  if (JSON.stringify(body.input ?? []).includes(prompt(scenario))) {
    if (requestContainsToolOutput(body, scenario)) {
      events.push(assistantMessage(completion(scenario)))
    } else if (requestAdvertisesShellTool(body)) {
      const target = join(server.workspacePath, fixture(scenario))
      const command =
        process.platform === 'win32'
          ? `Remove-Item -LiteralPath '${target.replaceAll("'", "''")}' -Force`
          : `rm -f '${target.replaceAll("'", "'\\''")}'`
      events.push(...shellCommandResponse(body, scenario, command, server.workspacePath))
      server.recordScenarioRequest(scenario, modelRequest)
    }
  }
  server.writeSse(response, [...events, responseCompleted(id)])
  return true
}

export async function verifyRiskyCommandApproval(control, workspacePath) {
  const trigger = '[data-testid="permission-mode-menu-button"]'
  const confirm = '[data-testid="full-access-confirm-submit"]'
  const allow = '[data-testid="request-user-input-option-__codex_approval-0"]'

  await control.command('click', trigger)
  await control.command('click', '[data-testid="permission-mode-full-access"]')
  for (const mode of ['manual', 'ai', 'automatic', 'ai']) {
    const option = `[data-testid="command-approval-confirm-option-${mode}"]`
    await control.command('waitFor', option, { visible: true, timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
    await control.command('click', option)
    const background = await control.command('getComputedStyleValue', confirm, {
      value: 'background-color',
    })
    const foreground = await control.command('getComputedStyleValue', confirm, { value: 'color' })
    assert.notEqual(background, 'rgba(0, 0, 0, 0)', `The ${mode} confirmation button needs a fill`)
    assert.notEqual(foreground, background, `The ${mode} confirmation label must be visible`)
  }
  await control.command('click', confirm)
  assert.match(await control.command('getAttribute', trigger, { value: 'aria-label' }), /AI/)
  await control.command('click', trigger)
  await control.command('click', '[data-testid="command-approval-manual"]')

  for (const scenario of RISKY_COMMAND_APPROVAL_SCENARIOS) {
    const path = join(workspacePath, fixture(scenario))
    await writeFile(path, 'isolated E2E fixture')
    if (scenario === 'risky_command_automatic') {
      await control.command('click', trigger)
      await control.command('click', '[data-testid="command-approval-automatic"]')
      for (const mode of ['manual', 'ai', 'automatic']) {
        await control.command(
          'waitFor',
          `[data-testid="command-approval-confirm-option-${mode}"]`,
          {
            visible: true,
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          }
        )
      }
      await control.command('click', '[data-testid="full-access-confirm-cancel"]')
      assert.match(
        await control.command('getAttribute', trigger, { value: 'aria-label' }),
        /manually|人工确认/
      )
      await control.command('click', trigger)
      await control.command('click', '[data-testid="command-approval-automatic"]')
      await control.command('click', confirm)
    }
    control.setScenario(scenario)
    await sendPromptUntilScenarioRequest(
      control,
      ACTIVE_COMPOSER_SELECTOR,
      prompt(scenario),
      scenario
    )
    if (scenario === 'risky_command_manual') {
      await control.command('waitFor', allow, { visible: true, timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
      await access(path)
      await control.command('click', allow)
    }
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: completion(scenario),
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await assert.rejects(access(path), { code: 'ENOENT' })
  }

  // The choices made in an existing conversation become the default for new ones.
  const selectedTask = '[data-testid^="runtime-local-task-row-"][aria-current="page"]'
  const taskTestId = await control.command('getAttribute', selectedTask, { value: 'data-testid' })
  assert.ok(taskTestId, 'The risky-command conversation is not selected')
  const taskRow = `[data-testid="${taskTestId}"]`
  for (const [mode, labels] of [
    ['automatic', ['Run risky commands automatically', '自动执行高危命令']],
    ['ai', ['Review risky commands with AI', 'AI 审核高危命令']],
    ['manual', ['Confirm risky commands manually', '人工确认高危命令']],
  ]) {
    if (mode !== 'automatic') {
      await control.command('click', taskRow)
      await control.command('waitFor', `${taskRow}[aria-current="page"]`, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', trigger)
      await control.command('click', `[data-testid="command-approval-${mode}"]`)
    }
    await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
    const restored = labels
      .map(label => `body:not(:has(${selectedTask})) ${trigger}[aria-label$="${label}"]`)
      .join(', ')
    await control.command('waitFor', restored, {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }
}
