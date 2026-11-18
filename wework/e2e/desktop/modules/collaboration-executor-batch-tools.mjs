import assert from 'node:assert/strict'

import { requestExecutor } from './executor-rpc.mjs'

const MARKER = `Executor batch ${process.pid}`
const cloudTarget = target => ({
  space: { project_store: 'backend', space_id: String(target.project.id) },
  item_id: target.issue.id,
})

function denied(entry) {
  assert.equal(entry.state, 'failed')
  assert.equal(entry.committed, false)
  assert.equal(entry.error.code, 'not_found')
  assert.equal(entry.error.message, 'Target is unavailable')
  assert.equal(entry.result, undefined, 'A denied nested target leaked its contents')
}

function succeeded(value, ids) {
  assert.deepEqual(
    value.results.map(entry => entry.request_id),
    ids
  )
  assert.equal(value.counts.succeeded, ids.length)
  assert.equal(value.counts.failed, 0)
  for (const entry of value.results) {
    assert.equal(entry.state, 'succeeded')
    assert.equal(entry.committed, true)
    assert.ok(Number.isInteger(entry.item_version) && entry.item_version > 0)
  }
}

/** Reuse the existing personal Runtime turn; only its model responses are synthetic. */
export function createExecutorBatchToolsRegression({ uiTimeoutMs }) {
  let request
  let owner
  let writer
  let viewer
  let forbidden
  let control
  let localProject
  let localSpace
  let created
  let updated
  let assigned
  const cloudItems = []
  const steps = []
  const creation = () => ({
    operation_key: `${MARKER} create`,
    items: ['local-first', 'local-second'].map(request_id => ({
      request_id,
      space: localSpace,
      item: { title: `${MARKER} ${request_id}` },
    })),
  })
  const entries = () => [
    ...created.results.map(entry => ({
      request_id: entry.request_id,
      target: entry.target,
      version: entry.item_version,
    })),
    ...cloudItems.map((issue, index) => ({
      request_id: `cloud-${index}`,
      target: cloudTarget({ project: writer.project, issue }),
      version: issue.version,
    })),
  ]
  const mutation = () => ({
    operation_key: `${MARKER} update`,
    items: entries().map(entry => ({
      request_id: entry.request_id,
      target: entry.target,
      expected_version: entry.version,
      patch: { title: `${MARKER} reviewed ${entry.request_id}` },
    })),
  })
  const assignment = () => ({
    operation_key: `${MARKER} assign`,
    items: updated.results.map(entry => ({
      request_id: entry.request_id,
      target: entry.target,
      expected_version: entry.item_version,
      assignee: { type: 'user', id: String(owner.id) },
      notify_assignee: false,
    })),
  })
  const receiptDenied = result =>
    assert.deepEqual(
      JSON.parse(result),
      { code: 'not_found', message: 'Target is unavailable', retryable: false },
      'Revocation must expose only the sanitized authorization error, without a receipt'
    )

  return {
    steps,
    async prepare(values) {
      request = values.request
      owner = values.owner
      writer = values.targets.find(target => target.permission === 'write' && target.token)
      viewer = values.targets.find(target => target.permission === 'read')
      forbidden = values.targets.find(target => target.permission === 'none')
      assert.ok(writer && viewer && forbidden)
      for (const index of [0, 1])
        cloudItems.push(
          await request(
            `/api/v1/cloud-projects/${writer.project.id}/loop-items`,
            { title: `${MARKER} cloud-${index}` },
            writer.token
          )
        )
      steps.push(
        {
          name: 'batch_create_board_items',
          args: creation,
          verify: value => {
            succeeded(value, ['local-first', 'local-second'])
            assert.ok(value.results.every(entry => entry.target.space.project_store === 'local'))
            created = value
          },
        },
        {
          name: 'batch_create_board_items',
          args: creation,
          verify: value => assert.deepEqual(value, created),
        },
        {
          name: 'batch_update_board_items',
          args: mutation,
          verify: value => {
            succeeded(
              value,
              entries().map(entry => entry.request_id)
            )
            value.results.forEach((entry, index) => {
              assert.deepEqual(entry.target, entries()[index].target)
              assert.equal(entry.item_version, entries()[index].version + 1)
            })
            updated = value
          },
        },
        {
          name: 'batch_update_board_items',
          args: mutation,
          verify: value => assert.deepEqual(value, updated),
        },
        {
          name: 'batch_get_board_items',
          args: () => ({
            items: [
              ...entries().map(({ request_id, target }) => ({ request_id, target })),
              { request_id: 'viewer', target: cloudTarget(viewer) },
              { request_id: 'nested-forbidden', target: cloudTarget(forbidden) },
              {
                request_id: 'nested-other-device',
                target: {
                  ...created.results[0].target,
                  space: { ...localSpace, device_id: `${localSpace.device_id}-untrusted` },
                },
              },
            ],
            include: ['permissions', 'attachment_metadata', 'delivery_summaries'],
          }),
          verify: value => {
            assert.deepEqual(
              value.results.map(entry => entry.request_id),
              [
                ...entries().map(entry => entry.request_id),
                'viewer',
                'nested-forbidden',
                'nested-other-device',
              ]
            )
            assert.equal(value.counts.succeeded, 5)
            assert.equal(value.counts.failed, 2)
            denied(value.results[5])
            assert.equal(value.results[6].state, 'failed')
            assert.equal(value.results[6].committed, false)
            assert.equal(value.results[6].error.code, 'scope_violation')
            assert.equal(value.results[6].result, undefined)
            for (const [index, entry] of value.results.slice(0, 4).entries()) {
              assert.equal(
                entry.result.item.title,
                `${MARKER} reviewed ${entries()[index].request_id}`
              )
              assert.equal(entry.result.item.version, updated.results[index].item_version)
            }
            assert.equal(value.results[4].result.item.id, viewer.issue.id)
            assert.equal(value.results[4].result.sections.permissions.state, 'complete')
            assert.equal(value.results[4].result.sections.permissions.value.edit_content, false)
          },
        },
        {
          name: 'batch_update_board_items',
          args: () => ({
            operation_key: `${MARKER} denied`,
            items: [
              ...[viewer, forbidden].map((target, index) => ({
                request_id: `denied-${index}`,
                target: cloudTarget(target),
                expected_version: target.issue.version,
                patch: { title: `${MARKER} must never persist` },
              })),
              {
                request_id: 'denied-other-device',
                target: {
                  ...created.results[0].target,
                  space: { ...localSpace, device_id: `${localSpace.device_id}-untrusted` },
                },
                expected_version: updated.results[0].item_version,
                patch: { title: `${MARKER} must never persist` },
              },
            ],
          }),
          verify: value => {
            assert.equal(value.counts.succeeded, 0)
            assert.equal(value.counts.failed, 3)
            value.results.slice(0, 2).forEach(denied)
            assert.equal(value.results[2].state, 'failed')
            assert.equal(value.results[2].committed, false)
            assert.equal(value.results[2].error.code, 'scope_violation')
            assert.equal(value.results[2].result, undefined)
          },
        },
        {
          name: 'batch_assign_board_items',
          args: assignment,
          verify: value => {
            succeeded(
              value,
              entries().map(entry => entry.request_id)
            )
            value.results.forEach((entry, index) => {
              assert.deepEqual(entry.target, updated.results[index].target)
              assert.equal(entry.item_version, updated.results[index].item_version + 1)
            })
            assigned = value
          },
        },
        {
          name: 'batch_assign_board_items',
          args: assignment,
          verify: value => assert.deepEqual(value, assigned),
        },
        {
          name: 'get_board_operation',
          args: () => ({ operation_key: `${MARKER} assign` }),
          verify: value => assert.deepEqual(value, assigned),
          after: () =>
            request(
              `/api/v1/cloud-projects/${writer.project.id}/members/${owner.id}`,
              undefined,
              writer.token,
              'DELETE'
            ),
        },
        {
          name: 'batch_get_board_items',
          args: () => ({
            items: entries().map(({ request_id, target }) => ({ request_id, target })),
          }),
          verify: value => {
            assert.equal(value.counts.succeeded, 2)
            assert.equal(value.counts.failed, 2)
            for (const entry of value.results.slice(0, 2)) {
              assert.equal(entry.state, 'succeeded')
              assert.equal(String(entry.result.item.assignee_user_id), String(owner.id))
            }
            value.results.slice(2).forEach(denied)
          },
        },
        {
          name: 'get_board_operation',
          args: () => ({ operation_key: `${MARKER} assign` }),
          verifyRaw: receiptDenied,
        },
        {
          name: 'batch_assign_board_items',
          args: assignment,
          verifyRaw: receiptDenied,
        }
      )
    },
    async prepareLocal(value) {
      control = value
      const { deviceId } = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
      assert.ok(deviceId, 'Batch targets require the trusted local Executor device identity')
      localProject = await requestExecutor(
        control,
        'projects.create',
        { name: MARKER },
        uiTimeoutMs
      )
      localSpace = { project_store: 'local', space_id: localProject.id, device_id: deviceId }
    },
    async verifyPersisted() {
      assert.ok(assigned, 'The personal Runtime did not execute the mixed-store assignment')
      for (const entry of assigned.results) {
        const item =
          entry.target.space.project_store === 'local'
            ? await requestExecutor(
                control,
                'todos.get',
                { project_id: localProject.id, task_id: entry.target.item_id },
                uiTimeoutMs
              )
            : await request(`/api/v1/loop-items/${entry.target.item_id}`, undefined, writer.token)
        assert.equal(item.title, `${MARKER} reviewed ${entry.request_id}`)
        assert.equal(item.version, entry.item_version, 'Replay repeated a committed mutation')
        assert.equal(String(item.assignee_user_id), String(owner.id))
        assert.equal(item.assignee_agent_id ?? null, null)
        assert.equal(item.assignee_group_id ?? null, null)
        assert.equal(item.assignee_team_id ?? null, null)
      }
      const localItems = await requestExecutor(
        control,
        'todos.list',
        { project_id: localProject.id },
        uiTimeoutMs
      )
      assert.equal(localItems.length, 2, 'Idempotent local creation duplicated Issues')
      console.log(
        '[e2e] Real Executor mixed-store writes, assignment and revoked receipt access verified'
      )
    },
  }
}
