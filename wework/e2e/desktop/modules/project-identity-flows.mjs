import {
  CLOUD_DEVICE_ID,
  COMPOSER_READY_STABILITY_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
} from './shared.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'

async function waitForProjectsByTitle(
  control,
  expectedTitle,
  expectedCount,
  message,
  timeoutMs,
  stableMs
) {
  const startedAt = Date.now()
  let matchingKey = null
  let matchingSince = null
  let projectIds = []
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const projectMenuTestIds = snapshot.testIds.filter(testId => testId.startsWith('project-menu-'))
    projectIds = []
    for (const projectMenuTestId of projectMenuTestIds) {
      const projectId = projectMenuTestId.slice('project-menu-'.length)
      const title = await control.command('getText', `[data-testid="project-title-${projectId}"]`)
      if (title.trim() === expectedTitle) projectIds.push(projectId)
    }
    projectIds.sort()
    if (projectIds.length === expectedCount) {
      const nextKey = JSON.stringify(projectIds)
      if (nextKey !== matchingKey) {
        matchingKey = nextKey
        matchingSince = Date.now()
      }
      if (Date.now() - matchingSince >= stableMs) return { projectIds, snapshot }
    } else {
      matchingKey = null
      matchingSince = null
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}; expected ${expectedCount} projects, found ${projectIds.join(', ')}`)
}

export async function waitForSingleProjectByTitle(
  control,
  expectedTitle,
  message,
  timeoutMs,
  stableMs = 0
) {
  const { projectIds, snapshot } = await waitForProjectsByTitle(
    control,
    expectedTitle,
    1,
    message,
    timeoutMs,
    stableMs
  )
  return { projectId: projectIds[0], snapshot }
}

export async function verifyLocalAndCloudProjectIdentity(control, projectTitle, cloudProjectId) {
  const debug = await waitForWorkbenchDebugState(
    control,
    snapshot => {
      const devices = snapshot.workbench?.devices ?? []
      const local = devices.find(device => device.device_type === 'local')
      const cloud = devices.find(device => device.device_id === CLOUD_DEVICE_ID)
      return (
        local?.runtime_instance_id &&
        cloud?.runtime_instance_id &&
        local.runtime_routes?.some(route => route.kind === 'local-ipc') &&
        local.runtime_routes?.some(route => route.kind === 'app-ipc')
      )
    },
    'The local Executor was not visible through both IPC and its real backend registration',
    WORKBENCH_READY_TIMEOUT_MS
  )
  const local = debug.workbench.devices.find(device => device.device_type === 'local')
  const cloud = debug.workbench.devices.find(device => device.device_id === CLOUD_DEVICE_ID)
  assert.notEqual(
    local.runtime_instance_id,
    cloud.runtime_instance_id,
    'The local and cloud fixtures must run independent Executors'
  )
  const { projectIds, snapshot } = await waitForProjectsByTitle(
    control,
    projectTitle,
    2,
    'Same-path projects on independent Executors must each appear once',
    WORKBENCH_READY_TIMEOUT_MS,
    COMPOSER_READY_STABILITY_MS * 4
  )
  assert.ok(projectIds.includes(cloudProjectId), 'The existing cloud project identity was lost')
  const localProjectId = projectIds.find(projectId => projectId !== cloudProjectId)
  assert.ok(snapshot.testIds.includes(`project-remote-folder-icon-${cloudProjectId}`))
  assert.ok(snapshot.testIds.includes(`project-folder-icon-${localProjectId}`))
  return localProjectId
}
