import assert from 'node:assert/strict'

export async function verifyRoundStandInAssignment({
  cloud,
  request,
  rpc,
  project,
  user,
  until,
  record,
}) {
  const created = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
    title: 'Stand-in handles manager round work using its owning Issue event',
    assignee_user_id: user.id,
    notify_assignee: false,
  })
  const direct = await request(`/v1/loop-items/${created.id}`)
  const eventId = direct.human_task_binding.assignmentId
  const memberId = `round-member-${process.pid}`
  const humanId = `round-human-${process.pid}`
  const messageId = `stand-in-round-${process.pid}`
  // Establish the persisted state produced by assign_round_owner and the manager activity.
  await cloud.executeDatabase(
    "UPDATE loop_items SET metadata=JSON_SET(metadata,'$.trigger','collaboration_round') WHERE id=%s",
    [eventId]
  )
  await cloud.executeDatabase(
    "INSERT INTO project_chat_messages (message_id,project_id,task_id,sender_type,sender_id,sender_name,content,metadata,runtime_activity_key) VALUES (%s,%s,%s,'agent','manager','Manager','',%s,%s)",
    [
      messageId,
      String(project.id),
      created.id,
      JSON.stringify({
        activity_type: 'manager_assignment',
        dispatch_id: messageId,
        coordination_round_id: 'round-1',
        dispatch_assignments: [
          {
            assignee_type: 'human',
            human_user_id: user.id,
            human_user_name: user.user_name,
            assignment_id: memberId,
            human_assignment_id: humanId,
          },
        ],
      }),
      messageId,
    ]
  )
  const issue = await request(`/v1/loop-items/${created.id}`)
  assert.equal(issue.human_task_binding.assignmentId, memberId)
  assert.equal(issue.human_task_binding.issueAssignmentId, eventId)
  const notice = {
    projectId: String(project.id),
    itemId: issue.id,
    assignmentId: memberId,
    recipientUserId: user.id,
  }
  await rpc('runtime.stand_in.assignment', notice)
  const bindings = await until(
    () => request(`/v1/loop-items/${issue.id}/tasks`),
    rows => rows.length === 1,
    'The round member work identity blocked stand-in dispatch'
  )
  assert.equal(bindings[0].assignment_id, memberId)
  assert.equal(bindings[0].human_assignment_id, humanId)
  const context = await request(
    `/v1/runtime-tasks/cloud-context?device_id=${encodeURIComponent(bindings[0].device_id)}&task_id=${encodeURIComponent(bindings[0].task_id)}`
  )
  assert.equal(context.loop_item.human_task_binding.issueAssignmentId, eventId)
  assert.equal(context.loop_item.human_task_binding.assignmentId, memberId)
  const taskId = bindings[0].task_id
  await until(
    () => rpc('runtime.tasks.get', { taskId }),
    value => {
      assert.notEqual(value.task?.status, 'failed', JSON.stringify(value))
      return value.task?.status === 'done'
    },
    'Round stand-in execution did not complete'
  )
  await until(
    () => request(`/v1/loop-items/${issue.id}/assignments`),
    value => value.items.some(row => row.id === eventId && row.stand_in_received_at),
    'Round reception was not acknowledged on the owning Issue assignment event'
  )
  const manual = await rpc('runtime.stand_in.run', {
    projectId: String(project.id),
    issueId: issue.id,
    userId: user.id,
    projectStore: 'cloud',
  })
  assert.equal(manual.taskId, taskId)
  await rpc('runtime.stand_in.assignment', { ...notice, assignmentId: 'superseded-member' })
  assert.equal((await request(`/v1/loop-items/${issue.id}/tasks`)).length, 1)
  await record('round-completed-with-event-receipt', issue)
}
