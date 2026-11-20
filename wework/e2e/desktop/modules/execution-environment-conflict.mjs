import assert from 'node:assert/strict'

const PREFIX = 'collaboration-project-execution-environment'

export async function verifyExecutionEnvironmentConflict(control, request, projectId, content) {
  const field = suffix => `${content} [data-testid="${PREFIX}-${suffix}"]`
  await control.command('clickWhenEnabled', field('preparation-toggle'))
  await control.command('waitFor', `${field('preparation-toggle')}[aria-expanded="true"]`)
  const originalPolicy = await control.command('getValue', field('workspace-policy'))
  const draftPolicy = originalPolicy === 'project' ? 'git_worktree' : 'project'
  await control.command('select', field('workspace-policy'), { value: draftPolicy })

  const baseline = await request(`/api/v1/cloud-projects/${projectId}`)
  const description = `${baseline.description ?? ''} · concurrent environment edit`
  const concurrent = await request(`/api/v1/cloud-projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      version: baseline.version,
      description,
      execution_environment: {
        workspace_policy: originalPolicy,
        repositories: baseline.execution_environment?.repositories ?? [],
        setup_steps: [{ command: 'printf concurrent-edit', working_directory: '' }],
      },
    }),
  })
  assert.ok(concurrent.version > baseline.version)
  await control.command('click', field('save-configuration'))
  await control.command('waitFor', field('configuration-error'), { text: '草稿尚未保存' })
  assert.equal(await control.command('getValue', field('workspace-policy')), draftPolicy)
  assert.equal((await request(`/api/v1/cloud-projects/${projectId}`)).version, concurrent.version)

  await control.command('clickWhenEnabled', field('rebase-configuration'))
  await control.command('waitFor', field('configuration-notice'), { text: '草稿尚未保存' })
  assert.equal(await control.command('getValue', field('workspace-policy')), draftPolicy)
  assert.equal((await request(`/api/v1/cloud-projects/${projectId}`)).version, concurrent.version)
  await control.command('clickWhenEnabled', field('save-configuration'))
  await control.command('waitFor', field('configuration-status'), { text: '配置已保存' })
  const saved = await request(`/api/v1/cloud-projects/${projectId}`)
  assert.equal(saved.description, description)
  assert.equal(saved.execution_environment.workspace_policy, draftPolicy)
  assert.deepEqual(
    saved.execution_environment.setup_steps,
    baseline.execution_environment?.setup_steps ?? []
  )

  await control.command('select', field('workspace-policy'), { value: originalPolicy })
  await control.command('clickWhenEnabled', field('save-configuration'))
  await control.command('waitFor', field('configuration-status'), { text: '配置已保存' })
  await control.command('click', field('preparation-toggle'))
  await control.command('waitFor', `${field('preparation-toggle')}[aria-expanded="false"]`)
}
