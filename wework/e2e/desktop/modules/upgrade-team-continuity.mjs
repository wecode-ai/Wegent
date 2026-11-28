import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { requestExecutor } from './executor-rpc.mjs'

export async function assertPackagedTeamProtocol(resources, expected) {
  const manifest = JSON.parse(await readFile(join(resources, 'components.json'), 'utf8'))
  assert.ok(expected === undefined || expected === 1, 'Unknown target Team assignment protocol')
  assert.equal(
    manifest.teamAssignmentProtocol,
    expected,
    'Pair metadata differs from the delivered Team protocol'
  )
}

export function createUpgradeTeamContinuity(control, timeoutMs) {
  const rpc = (method, params) => requestExecutor(control(), method, params, timeoutMs)
  const leader = { kind: 'human', id: '0', name: 'Owner' }
  const member = { kind: 'human', id: '42', name: 'Reviewer' }
  const group = {
    id: randomUUID(),
    name: 'Release review',
    leader,
    members: [leader, member],
    stages: [],
  }
  let project
  let history
  let submission
  let receipt
  let delivery
  const create = title =>
    rpc('todos.create', {
      project_id: project.id,
      todo: { title, status: 'in_progress', assignee_group_id: group.id },
    })
  const read = id => rpc('todos.get', { project_id: project.id, task_id: id })
  const coordinate = (action, input = {}) =>
    rpc('runtime.issue_coordination.' + action, {
      userId: 0,
      projectId: project.id,
      input: { loopItemId: history.id, ...input },
    })
  async function verifyHistory(status) {
    const row = await read(history.id)
    assert.equal(row.id, history.id)
    assert.equal(row.cloud_project_id, project.id)
    assert.equal(row.status, status)
    assert.deepEqual(row.metadata.collaboration_group, group)
    assert.deepEqual(row.metadata.assignment_history, history.metadata.assignment_history)
  }
  async function verifyDelivery() {
    const state = await coordinate('get')
    assert.equal(state.dispatchId, submission.dispatchId)
    assert.equal(state.waitingForMembers, false)
    assert.deepEqual(state.assignments, [
      {
        assigneeId: member.id,
        assigneeType: 'human',
        assignmentId: 'review',
        humanAssignmentId: receipt.assignments[0].human_assignment_id,
        status: 'completed',
      },
    ])
    assert.equal((await read(history.id)).status, 'completed')
    assert.equal(
      (await read(receipt.assignments[0].human_assignment_id)).current_delivery_id,
      delivery.id
    )
  }
  const continuity = {
    async seed() {
      project = await rpc('projects.create', { name: 'Upgrade Team continuity' })
      await rpc('projects.update', {
        project_id: project.id,
        project: { version: project.version, collaboration_groups: [group] },
      })
      history = await create('Historical Team work in progress')
      assert.ok(history.metadata.assignment_history.length > 0)
      await verifyHistory('in_progress')
    },
    async upgrade() {
      await verifyHistory('in_progress')
      const view = await coordinate('get')
      assert.equal(view.canCoordinate, true)
      assert.deepEqual(view.leader, leader)
      submission = {
        dispatchId: view.dispatchId,
        roundId: view.roundId,
        items: [
          {
            assignment_id: 'review',
            assignee_type: 'human',
            assignee_id: member.id,
            title: 'Review package',
            instructions: 'Record the package review',
          },
        ],
      }
      receipt = await coordinate('submit', submission)
      assert.equal(receipt.assignments.length, 1)
      const child = receipt.assignments[0].human_assignment_id
      assert.ok(child)
      assert.equal((await read(child)).parent_id, history.id)
      assert.equal((await coordinate('get')).waitingForMembers, true)
      delivery = await rpc('deliveries.create', {
        project_id: project.id,
        item_id: child,
        delivery: { title: 'Review', markdown: 'Reviewed package' },
      })
      await rpc('deliveries.finalize', {
        item_id: child,
        delivery_id: delivery.id,
        finalize: { fulfillments: [] },
      })
      const next = await coordinate('get')
      assert.equal(next.canCoordinate, true)
      await coordinate('decide', {
        dispatchId: next.dispatchId,
        roundId: next.roundId,
        targetStatus: 'completed',
        reason: 'Review delivered',
        idempotencyKey: 'finish-review',
      })
      await verifyDelivery()
    },
    async rollback(preservedDirectory) {
      await verifyHistory(preservedDirectory ? 'in_progress' : 'completed')
      if (preservedDirectory) {
        const db = new DatabaseSync(join(preservedDirectory, 'data/tasks.sqlite'), {
          readOnly: true,
        })
        try {
          const row = db.prepare(
            'SELECT status, parent_id, current_delivery_id FROM loop_items WHERE id = ?'
          )
          assert.equal(row.get(history.id).status, 'completed')
          const child = row.get(receipt.assignments[0].human_assignment_id)
          assert.equal(child.parent_id, history.id)
          assert.equal(child.current_delivery_id, delivery.id)
        } finally {
          db.close()
        }
      } else {
        const child = await read(receipt.assignments[0].human_assignment_id)
        assert.equal(child.parent_id, history.id)
        assert.equal(child.current_delivery_id, delivery.id)
      }
    },
    async reupgrade(restored) {
      // Re-upgrade starts from the restored live database.
      if (restored) await continuity.upgrade()
      await verifyHistory('completed')
      await verifyDelivery()
      assert.deepEqual(await coordinate('submit', submission), receipt)
      return {
        projectId: project.id,
        groupId: group.id,
        historicalIssue: history.id,
        dispatchId: submission.dispatchId,
        receipt,
        deliveryId: delivery.id,
      }
    },
  }
  return continuity
}
