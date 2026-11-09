import { isAbsolute, relative, resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { assert, commandOutputAsync, fetchJson, readFile, runChecked } from './shared.mjs'
import { requestExecutor } from './executor-rpc.mjs'

// App remote control remains disabled. Backend creation uses its authorized
// record-scoped route; workspace commands use the existing Executor IPC transport.
export async function verifyBackendGitProjectCreation(control, cloud, fixture, setPhase) {
  setPhase('git-clone-recovery-backend-project-cwd')
  const headers = {
    Authorization: `Bearer ${cloud.authToken}`,
    'Content-Type': 'application/json',
  }
  const device = await cloud.waitForConnectedAppDevice()
  assert.ok(device.execution_target_id, 'Backend creation requires the exact App device route')
  const command = async (command_key, path, args = []) => {
    const result = await requestExecutor(control, 'device.execute_command', {
      command_key,
      path,
      args,
    })
    assert.equal(result.success, true, `${command_key}: ${JSON.stringify(result)}`)
    return result.stdout.trim()
  }
  const workspaceRoot = await command('project_workspace_root')
  let project
  let checkout
  try {
    const created = await fetchJson(`${cloud.backendUrl}/api/projects/git-workspace`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        device_id: device.execution_target_id,
        client_origin: 'wework',
        name: 'Backend caller workspace regression',
        git: {
          url: fixture.source,
          repo: 'backend-caller-workspace-regression',
          domain: fixture.domain,
          branch: 'develop',
        },
      }),
    })
    project = created.project
    assert.ok(project?.id, 'Backend Git creation must persist a project')
    assert.equal(created.reused_existing_checkout, false)
    assert.equal(isAbsolute(created.checkout_path), false)
    const candidate = resolve(workspaceRoot, created.checkout_path)
    const relativeCheckout = relative(workspaceRoot, candidate)
    assert.ok(
      relativeCheckout && !relativeCheckout.startsWith('..') && !isAbsolute(relativeCheckout)
    )
    checkout = candidate
    assert.equal(await readFile(resolve(checkout, 'README.md'), 'utf8'), '# Private Git recovery\n')
    await runChecked('git', ['rev-parse', '--is-inside-work-tree'], { cwd: checkout })
    assert.equal(await command('git_branch', checkout), 'develop')
    assert.equal(await command('git_remote_url', checkout), fixture.source)
    // Inspect persisted identity; git_config is not registered in App IPC.
    assert.equal(
      await commandOutputAsync('git', ['config', '--local', '--get', 'user.name'], {
        cwd: checkout,
      }),
      'oauth2'
    )
    assert.equal(
      await commandOutputAsync('git', ['config', '--local', '--get', 'user.email'], {
        cwd: checkout,
      }),
      'recovery@example.test'
    )
    const listed = await fetchJson(
      `${cloud.backendUrl}/api/projects?client_origin=wework&include_tasks=false`,
      { headers }
    )
    const persisted = listed.items.find(item => item.id === project.id)
    assert.equal(persisted?.config.workspace.checkoutPath, created.checkout_path)
    assert.equal(persisted?.config.execution.deviceId, device.execution_target_id)
  } finally {
    try {
      if (project) {
        const deleted = await fetch(
          `${cloud.backendUrl}/api/projects/${project.id}?client_origin=wework`,
          {
            method: 'DELETE',
            headers,
          }
        )
        assert.equal(deleted.status, 204, 'Backend regression project cleanup failed')
      }
    } finally {
      if (checkout) await rm(checkout, { recursive: true, force: true })
    }
  }
}
