import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'

export const STORY_USER = 9001
export const STORY_PRIMARY = `stand-in-chat-${STORY_USER}-primary`
export const STORY_CHAT =
  '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-conversation"]'

export async function storyUntil(load, ready, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await load()
    if (ready(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${label}: ${JSON.stringify(latest)}`)
}

export async function openStoryPrimary(control) {
  await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
  await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-open"]')
  await control.command('waitFor', STORY_CHAT)
}

export async function startSourceStory(
  control,
  rpc,
  options,
  modelState,
  source,
  roleId,
  { rolePrompt } = {}
) {
  await control.command('ensureLocalModelCatalogReady', 'body', {
    timeoutMs: options.workbenchReadyTimeoutMs,
  })
  const original = await rpc('runtime.stand_in.personal.get', { userId: STORY_USER })
  const catalog = await rpc('runtime.runner.catalog', {})
  const model = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
  assert.ok(model, 'Use the actual configured E2E model')
  const workspace = {
    projectKey: `${roleId}-workspace`,
    workspacePath: options.workspacePath,
    executionMode: 'current_workspace',
  }
  await control.command('seedLocalProject', 'body', {
    value: JSON.stringify({
      projectKey: workspace.projectKey,
      name: roleId,
      path: options.workspacePath,
    }),
  })
  modelState.active = true
  const saved = await rpc('runtime.stand_in.personal.save', {
    userId: STORY_USER,
    settings: {
      ...original,
      primary: {
        ...original.primary,
        enabled: true,
        prompt: '',
        preferences: '',
        model,
        workspace,
        connections: [],
      },
      roles: [
        {
          id: roleId,
          name: roleId,
          enabled: true,
          version: 0,
          executionDeviceId: original.executionDeviceId,
          model,
          workspace,
          prompt:
            rolePrompt ??
            `${modelState.marker ?? roleId}: handle only the connected source under its current grant.`,
          connections: [source],
          tags: [],
          collaboration: {
            enabled: false,
            allProjects: false,
            projects: [],
            excludedProjects: [],
            tags: [],
          },
        },
      ],
    },
  })
  await ensureExperimentalFeaturesEnabled(control)
  await openStoryPrimary(control)
  return { original, saved }
}

export async function assertStoryPrimaryOutcome(control, rpc, fact, timeoutMs) {
  const transcript = await storyUntil(
    () => rpc('runtime.tasks.transcript', { taskId: STORY_PRIMARY, limit: 100 }),
    value =>
      value.messages?.some(
        message => message.role === 'assistant' && message.content?.includes(fact)
      ),
    timeoutMs,
    'The completed useful outcome must return to the original primary conversation'
  )
  assert.equal(
    transcript.messages.filter(
      message => message.role === 'assistant' && message.content?.includes(fact)
    ).length,
    1,
    'The primary must report each concrete outcome exactly once'
  )
  await openStoryPrimary(control)
  await control.command('waitFor', `${STORY_CHAT} [data-testid="message-assistant"]`, {
    text: fact,
    timeoutMs,
  })
  return transcript
}

export async function restoreSourceStory(rpc, original, modelState) {
  const current = await rpc('runtime.stand_in.personal.get', { userId: STORY_USER })
  await rpc('runtime.stand_in.personal.save', {
    userId: STORY_USER,
    settings: { ...original, version: current.version },
  })
  modelState.active = false
}
