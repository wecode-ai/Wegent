import assert from 'node:assert/strict'
import { waitForValue } from './workspace-agent-setup.mjs'
import {
  waitForCompletedRuntimeTaskThread,
  waitForRunningRuntimeTask,
} from './runtime-task-evidence.mjs'

export const COLLABORATION_EXP_RHYTHM_ROLE = 'collaboration-exp-rhythm'
export const COLLABORATION_EXP_RHYTHM_MARKER = 'COLLABORATION_EXP_REAL_RUNNING_WORK'

/** Use public dispatch and lifecycle reads; never seed native execution metadata. */
export function createCollaborationExpRhythmFixture(rpc, timeoutMs) {
  let original
  let ownerId
  let runningIssue
  let taskId
  return {
    async prepare(project, completedIssue, fallbackOwnerId) {
      const binding = await rpc('runtime.stand_in.binding', { operation: 'get' })
      ownerId = binding.target?.userId ?? fallbackOwnerId
      original = await rpc('runtime.stand_in.personal.get', { userId: ownerId })
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model, 'The real runner must expose its configured E2E model')
      const target = {
        projectId: project.id,
        projectStore: 'local',
        userId: ownerId,
        standInId: COLLABORATION_EXP_RHYTHM_ROLE,
      }
      const settings = await rpc('runtime.stand_in.get', target)
      const saved = await rpc('runtime.stand_in.save', {
        ...target,
        settings: {
          ...settings,
          enabled: true,
          name: 'Integration assistant',
          prompt: COLLABORATION_EXP_RHYTHM_MARKER,
          model,
        },
      })
      assert.equal(saved.enabled, true)
      assert.equal(saved.id, COLLABORATION_EXP_RHYTHM_ROLE)
      const configured = await rpc('runtime.stand_in.personal.get', { userId: ownerId })
      const role = configured.roles.find(role => role.id === COLLABORATION_EXP_RHYTHM_ROLE)
      assert.ok(role, 'The project-addressed configuration must persist in the real personal team')
      if (configured.roles[0]?.id !== role.id)
        await rpc('runtime.stand_in.personal.save', {
          userId: ownerId,
          settings: {
            ...configured,
            roles: [role, ...configured.roles.filter(candidate => candidate.id !== role.id)],
          },
        })
      runningIssue = await rpc('todos.create', {
        project_id: project.id,
        todo: { title: COLLABORATION_EXP_RHYTHM_MARKER },
      })
      await rpc('runtime.stand_in.run', { ...target, issueId: runningIssue.id })
      const bindings = await waitForValue(
        () => rpc('todos.bindings', { task_id: runningIssue.id }),
        rows => rows.length > 0 && rows,
        'Task rhythm requires its real Issue-to-runtime binding',
        timeoutMs
      )
      assert.equal(bindings.length, 1)
      assert.equal(bindings[0].loop_item_id, runningIssue.id)
      taskId = bindings[0].task_id
      assert.ok(taskId, 'The existing binding must identify its native task')
      const address = { deviceId: bindings[0].device_id, taskId }
      assert.ok(address.deviceId, 'The existing binding must retain its owning native device')
      const native = await waitForRunningRuntimeTask(
        async id => {
          const response = await rpc('runtime.tasks.get', { taskId: id })
          assert.equal(response.success, true)
          return response.task
        },
        taskId,
        timeoutMs
      )
      assert.equal(native.status, 'running')
      assert.equal(native.runtimeHandle.origin.type, 'issue_dispatch')
      assert.equal(native.runtimeHandle.origin.initiatedBy, 'stand_in')
      assert.equal(native.runtimeHandle.origin.standInId, COLLABORATION_EXP_RHYTHM_ROLE)
      assert.equal(native.runtimeHandle.origin.userId, ownerId)
      assert.equal(native.runtimeHandle.origin.projectStore, 'local')
      assert.equal(native.runtimeHandle.origin.cloudProjectId, project.id)
      assert.equal(native.runtimeHandle.origin.loopItemId, runningIssue.id)
      runningIssue = await waitForValue(
        () => rpc('todos.get', { project_id: project.id, task_id: runningIssue.id }),
        issue => issue.status === 'in_progress' && issue,
        'The actual running native task must project its bound Issue as in progress',
        timeoutMs
      )
      const current = await rpc('todos.get', {
        project_id: project.id,
        task_id: completedIssue.id,
      })
      const completed = await rpc('todos.update', {
        project_id: project.id,
        task_id: completedIssue.id,
        todo: { version: current.version, status: 'completed' },
      })
      assert.equal(completed.status, 'completed')
      return { runningIssue, completed, ownerId, taskId, address }
    },
    async assertCompleted(control) {
      assert.ok(taskId, 'The running fixture must have a real bound native task')
      await waitForCompletedRuntimeTaskThread(control, taskId, timeoutMs)
      const native = await rpc('runtime.tasks.get', { taskId })
      assert.equal(native.task.status, 'done')
      assert.notEqual(native.task.running, true)
    },
    async cleanup() {
      if (!original) return
      const latest = await rpc('runtime.stand_in.personal.get', { userId: ownerId })
      await rpc('runtime.stand_in.personal.save', {
        userId: ownerId,
        settings: { ...original, version: latest.version },
      })
    },
  }
}

export function assertUnchangedGeometry(before, after, label) {
  assert.equal(after.length, before.length, `${label} changed element count`)
  for (const [index, box] of before.entries())
    for (const key of ['left', 'top', 'width', 'height'])
      assert.ok(
        Math.abs(box[key] - after[index][key]) <= 1,
        `${label} shifted ${key}: ${box[key]} -> ${after[index][key]}`
      )
}

export function assertNoStateAnimation(name, duration, label) {
  assert.ok(
    name.split(',').every(value => value.trim() === 'none'),
    `${label}: ${name}`
  )
  assert.ok(
    duration.split(',').every(value => Number.parseFloat(value) === 0),
    `${label} retains an animation duration: ${duration}`
  )
}
