import { waitForValue } from './wait.mjs'
import assert from 'node:assert/strict'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'

export async function verifyAssistantTeamCreation(control, rpc, settings, captureScreenshot) {
  const userId = settings.userId
  const projectId = 'default-work-items'
  const select = id => `[data-testid="${id}"]`
  const click = id => control.command('clickWhenEnabled', select(id), { timeoutMs: 5000 })
  const fill = (id, value) => control.command('fill', select(id), { value })
  const closed = () =>
    control.command('waitFor', select('stand-in-profile-panel'), {
      visible: false,
      timeoutMs: 5000,
    })
  const read = async () => (await rpc('runtime.stand_in.personal.get', { userId })).roles
  const open = async role => {
    await click('stand-in-overview-role-' + role.id)
    await openStandInSettings(control)
  }
  const create = async (name, teamId) => {
    const previous = new Set((await read()).map(role => role.id))
    await click('stand-in-create-role')
    await click('stand-in-chat-advanced')
    if (teamId)
      await fill('stand-in-prompt', 'Discard this new-Team draft when referencing a Team.')
    await click('stand-in-create-team')
    await click('stand-in-create-team-option-' + (teamId ?? 'new'))
    await fill('stand-in-role-name', name)
    await captureScreenshot(
      control,
      teamId ? 'assistant-reference-existing.png' : 'assistant-create-new.png'
    )
    await click('stand-in-save')
    await closed()
    const added = (await read()).filter(role => !previous.has(role.id))
    assert.equal(added.length, 1)
    assert.equal(added[0].name, name)
    return added[0]
  }

  const owned = await create('Desktop own Team')
  assert.ok(owned.teamRef)
  await open(owned)
  await fill('stand-in-prompt', 'Edit this assistant directly.')
  await click('stand-in-save')
  await closed()
  const updated = (await read()).find(role => role.id === owned.id)
  assert.equal(updated.teamRef, owned.teamRef)
  assert.equal(updated.prompt, 'Edit this assistant directly.')

  const catalog = await rpc('runtime.runner.catalog', {})
  const model = catalog.models.find(row => row.runtime === 'codex' && row.is_default)
  assert.ok(model, 'The source Team requires the configured device model')
  const source = await rpc('chat_agents.create', {
    project_id: projectId,
    agent: {
      name: 'desktop-shared-release-team',
      runtime: 'codex',
      created_by_user_id: userId,
      system_prompt: 'Review the original release plan.',
      execution_policy: { mode: 'fixed', environment_id: settings.executionDeviceId },
      model_policy: {
        mode: 'fixed',
        model: { runtime: model.runtime, provider: model.provider, model_id: model.model_id },
      },
    },
  })
  const readSource = async () =>
    (await rpc('chat_agents.list', { project_id: projectId })).find(row => row.id === source.id)
  const original = await readSource()
  assert.ok(original)
  const linked = await create('Desktop linked Team', source.id)
  assert.equal(linked.teamRef, source.id)
  assert.ok(!linked.prompt.includes('Discard this new-Team draft'))
  await open(linked)
  await control.command('waitFor', select('stand-in-prompt'), { timeoutMs: 5000 })
  await waitForValue(
    () => control.command('getValue', select('stand-in-prompt')),
    value => value === original.system_prompt,
    'The linked assistant editor must display the current source Team prompt',
    5000
  )
  const editedPrompt = 'Review this assistant’s release checklist.'
  await fill('stand-in-prompt', editedPrompt)
  await click('stand-in-save')
  await control.command('waitFor', select('stand-in-copy-team-confirm'))
  await captureScreenshot(control, 'assistant-copy-team-confirmation.png')
  await click('stand-in-copy-team-cancel')
  assert.deepEqual(
    (await read()).find(role => role.id === linked.id),
    linked
  )
  assert.deepEqual(await readSource(), original)

  await click('stand-in-save')
  await click('stand-in-copy-team-confirm')
  await closed()
  const copied = (await read()).find(role => role.id === linked.id)
  assert.ok(copied.teamRef)
  assert.notEqual(copied.teamRef, source.id)
  assert.equal(copied.prompt, editedPrompt)
  const { portableTeam } = await rpc('runtime.stand_in.personal.get', {
    userId,
    exportTeamRoleId: copied.id,
  })
  assert.equal(portableTeam.system_prompt, editedPrompt)
  assert.deepEqual(await readSource(), original)
  await open(copied)
  assert.equal(await control.command('getValue', select('stand-in-prompt')), editedPrompt)
  await captureScreenshot(control, 'assistant-copied-team-saved.png')
  await click('stand-in-close')
}
