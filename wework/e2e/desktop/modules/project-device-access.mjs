import assert from 'node:assert/strict'

// The shared-core checkpoint creates the project and real remote runner first.
export async function verifyProjectDeviceAccess(
  control,
  { scoped, request, project, deviceId, timeoutMs }
) {
  const prefix = `project-device-access-${deviceId}`
  const target = suffix => scoped(`[data-testid="${prefix}-${suffix}"]`)
  await control.command(
    'click',
    scoped('[data-testid="collaboration-project-execution-environment-add"]')
  )
  const load = async () => {
    const response = await request(`/api/v1/cloud-projects/${project.id}/execution-environments`)
    const row = response.items.find(item => item.device_id === deviceId)
    assert.ok(row, 'The configured project runner is missing')
    return row
  }
  assert.deepEqual((await load()).use_access, { scope: 'owner', member_ids: [] })
  // Later shared-session checks need project members to use this runner.
  for (const scope of ['project', 'owner', 'project']) {
    await control.command('click', target('edit'))
    await control.command('select', target('scope'), { value: scope })
    await control.command('clickWhenEnabled', target('save'), { timeoutMs })
    await control.command('waitFor', scoped(`[data-testid="${prefix}"] [role="status"]`), {
      text: '使用权限已保存',
      timeoutMs,
    })
    assert.deepEqual((await load()).use_access, { scope, member_ids: [] })
    await control.command('click', scoped('[data-testid="collaboration-project-settings-project"]'))
    await control.command(
      'click',
      scoped('[data-testid="collaboration-project-settings-environments"]')
    )
    await control.command('waitFor', target('edit'), {
      text: scope === 'owner' ? '仅设备所有者' : '项目可执行成员',
      timeoutMs,
    })
  }
}
