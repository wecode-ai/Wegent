import assert from 'node:assert/strict'
import { selectCollaborationProjectView } from './collaboration-project-navigation.mjs'
import { waitForBoardValue } from './collaboration-board-flows.mjs'

export async function verifyProjectAgentEditing(control, content, project, agent, request) {
  const scoped = testId => `${content} [data-testid="${testId}"]`
  const dialog = '[data-testid="cloud-project-chat-agent-editor"]'
  const name = `${agent.name}（已编辑）`
  const prompt = 'Edited project Agent prompt: keep the original execution policy.'
  await selectCollaborationProjectView(control, content, 'manage')
  await control.command('click', scoped('collaboration-project-settings-agents'))
  await control.command('clickWhenEnabled', scoped(`project-agent-edit-${agent.id}`))
  await control.command('waitFor', dialog)
  await waitForBoardValue(
    () => control.command('getValue', '[data-testid="cloud-project-chat-agent-display-name"]'),
    agent.name,
    'The definition form must finish loading before editing',
    10_000
  )
  await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
    value: name,
  })
  await control.command('fill', '[data-testid="cloud-project-chat-agent-system-prompt"]', {
    value: prompt,
  })
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]')
  await control.command('waitFor', dialog, { visible: false })
  await control.command('waitFor', scoped(`project-agent-row-${agent.id}`), { text: name })

  const rows = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`)
  const saved = rows.find(row => row.id === agent.id)
  assert.ok(saved, 'Editing must retain the original Agent identity')
  assert.equal(saved.name, name)
  assert.equal(saved.systemPrompt ?? saved.system_prompt, prompt)
  for (const [camel, snake] of [
    ['executionPolicy', 'execution_policy'],
    ['modelPolicy', 'model_policy'],
    ['executionEnvironment', 'execution_environment'],
    ['executionMode', 'execution_mode'],
    ['executionDeviceId', 'execution_device_id'],
    ['workspacePolicy', 'workspace_policy'],
  ]) {
    assert.deepEqual(
      saved[camel] ?? saved[snake],
      agent[camel] ?? agent[snake],
      `Editing must preserve ${camel}`
    )
  }
  await control.command('clickWhenEnabled', scoped(`project-agent-edit-${agent.id}`))
  await control.command('waitFor', dialog)
  await waitForBoardValue(
    () => control.command('getValue', '[data-testid="cloud-project-chat-agent-display-name"]'),
    name,
    'The reopened definition form must load the saved Agent',
    10_000
  )
  assert.equal(
    await control.command('getValue', '[data-testid="cloud-project-chat-agent-display-name"]'),
    name
  )
  assert.equal(
    await control.command('getValue', '[data-testid="cloud-project-chat-agent-system-prompt"]'),
    prompt
  )
  await control.command('click', '[data-testid="cloud-project-chat-agent-cancel"]')
  await control.command('waitFor', dialog, { visible: false })
}
