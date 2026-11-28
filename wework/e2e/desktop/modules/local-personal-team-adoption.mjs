import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from './executor-rpc.mjs'
import { disconnectDesktopCloud } from './desktop-cloud-login.mjs'
import { standInRoleFixture } from './stand-in-role-fixture.mjs'
import { selectCollaborationProjectView } from './collaboration-project-navigation.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

const privateSkill = 'personal-release-approval'
export const adoptedIssue = '核验本地采用团队的签收'
export const sourceInstructions = '核验本地采用来源的签收编号'
export const adoptedReceipt = '项目虚拟成员已核验采用团队的签收编号'

export const pipelineIssue = '核验本地采用流水线的双人签收'
export const pipelineReview = '请复核上一位机器人提供的签收编号'
export const pipelineHandoff = '交接编号 LOCAL-PIPELINE-51'
export const pipelineReceipt = '项目虚拟成员已复核 LOCAL-PIPELINE-51 并签收'

export async function verifyLocalPersonalTeamAdoption(
  control,
  {
    content,
    projectName,
    agentId,
    pipeline,
    assignIssue,
    uiTimeoutMs,
    modelResponseTimeoutMs,
    captureScreenshot,
    resultDir,
  }
) {
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const click = id =>
    control.command('clickWhenEnabled', `[data-testid="${id}"]`, { timeoutMs: uiTimeoutMs })
  // Complete the project flow under the installation identity, with its cloud session disconnected.
  if (!pipeline) {
    await disconnectDesktopCloud(control)
    await click('settings-back-button')
    await click('workspace-tab-select-fixed-board')
  }
  const roleId = pipeline ? 'pipeline-review' : 'release-review'
  const title = pipeline ? pipelineIssue : adoptedIssue
  const expectedReceipt = pipeline ? pipelineReceipt : adoptedReceipt
  const prefix = pipeline ? 'local-pipeline' : 'local-coordinate'
  const bots = [
    { id: 51, name: 'Reviewer', shell_type: 'Codex', system_prompt: sourceInstructions },
  ]
  if (pipeline) {
    bots[0].context_passing = 'previous_bot'
    bots.push({ id: 52, name: 'Auditor', shell_type: 'Codex', system_prompt: pipelineReview })
  }
  const owner = 0
  const profile = await rpc('runtime.stand_in.personal.get', { userId: owner })
  const source = {
    id: randomUUID(),
    name: pipeline ? '本地流水线验收团队' : '本地采用验收团队',
    leadId: roleId,
    members: { [roleId]: '核验交付' },
  }
  const role = {
    ...standInRoleFixture(profile.executionDeviceId, roleId),
    name: pipeline ? '流水线签收助理' : '签收助理',
    enabled: true,
    migrationSource: JSON.stringify(['source-device', owner, roleId]),
  }
  const settings = await rpc('runtime.stand_in.personal.save', {
    userId: owner,
    transferRoleId: roleId,
    portableTeam: {
      name: role.name,
      collaboration_model: pipeline ? 'pipeline' : 'solo',
      bot: bots,
    },
    settings: {
      ...profile,
      roles: [...profile.roles, role],
      teams: [...(profile.teams ?? []), source],
    },
  })
  const sourceRef = settings.roles.find(row => row.id === roleId).teamRef
  assert.ok(sourceRef && sourceRef !== agentId)
  await rpc('runtime.stand_in.personal.save', {
    userId: owner,
    settings,
    ownedTeam: { roleId, botGrants: bots.map(({ id }) => ({ id, skills: [privateSkill] })) },
  })

  const project = (await rpc('projects.list', {})).find(item => item.name === projectName)
  assert.ok(project)
  await click(`collaboration-workspace-project-${project.id}`)
  const persisted = async () => {
    const item = (await rpc('projects.list', {})).find(row => row.id === project.id)
    return item.metadata.collaboration_groups.filter(group => group.name === source.name)
  }
  await selectCollaborationProjectView(control, content, 'manage')
  await click('collaboration-project-settings-groups')
  let group
  for (let attempt = 0; attempt < (pipeline ? 1 : 2); attempt++) {
    await click('project-personal-team-open')
    await click('project-personal-team-select')
    await click(`project-personal-team-select-option-${source.id}`)
    await click(`project-personal-team-member-${roleId}`)
    await click(`project-personal-team-member-${roleId}-option-${agentId}`)
    if (attempt === 0)
      await captureScreenshot(control, `${prefix}-08-personal-team-mapping.png`, content)
    await click('project-personal-team-adopt')
    await control.command('waitFor', '[data-testid="project-personal-team-open"]', {
      timeoutMs: uiTimeoutMs,
    })
    const groups = await persisted()
    assert.equal(groups.length, 1)
    assert.equal(groups[0].personal_team_managed, true)
    assert.deepEqual(
      groups[0].members.map(member => [member.kind, member.id]),
      [['agent', agentId]]
    )
    if (group) assert.deepEqual(groups[0], group, 'Repeated adoption changed the project group')
    group = groups[0]
  }
  await assignIssue(title, source.name, '请核验项目交付并回复签收编号。')
  await captureScreenshot(control, `${prefix}-09-adopted-group-assignee.png`, content)
  let beforeSignoff
  if (pipeline) {
    try {
      await pipeline.waitForReviewer()
      const item = (await rpc('todos.list', { project_id: project.id })).find(
        row => row.title === title
      )
      assert.equal(item.status, 'in_progress')
      const claims = (
        await rpc('executions.list', { project_id: project.id, include_terminal: true })
      ).filter(row => row.loop_item_id === item.id)
      assert.equal(claims.length, 1)
      const [claim] = claims
      assert.equal(claim.agent_id, agentId)
      assert.ok(claim.claimed_at && claim.runtime_task_id)
      assert.equal(claim.status, 'running')
      const comments = await rpc('todos.comment.list', { project_id: project.id, task_id: item.id })
      const receipts = comments.filter(
        row =>
          row.metadata.execution_id === claim.id &&
          row.metadata.activity_type === 'manager_status_comment'
      )
      assert.equal(receipts.length, 0)
      beforeSignoff = {
        issueStatus: item.status,
        executionId: claim.id,
        executionStatus: claim.status,
        runtimeTaskId: claim.runtime_task_id,
        receipts: receipts.length,
      }
    } finally {
      pipeline.releaseReviewer()
    }
  }
  await control.command('waitFor', `${content} [data-testid="cloud-task-activity-list"]`, {
    text: expectedReceipt,
    timeoutMs: modelResponseTimeoutMs,
  })
  const issue = (await rpc('todos.list', { project_id: project.id })).find(
    row => row.title === title
  )
  assert.ok(issue)
  assert.equal(issue.status, 'in_review')
  const runs = await waitForValue(
    async () =>
      (await rpc('executions.list', { project_id: project.id, include_terminal: true })).filter(
        row => row.loop_item_id === issue.id
      ),
    rows => rows.some(row => row.status === 'completed'),
    'The adopted group did not complete its local execution',
    uiTimeoutMs
  )
  assert.equal(runs.length, 1)
  const [run] = runs
  assert.equal(run.assigner_user_id, owner)
  assert.equal(run.agent_id, agentId)
  assert.ok(run.claimed_at && run.runtime_device_id && run.runtime_task_id)
  const request = run.runtime_payload.executionRequest
  assert.equal(request.team_ref, agentId)
  assert.deepEqual(
    request.bot.map(bot => bot.id),
    bots.map(bot => bot.id)
  )
  if (pipeline) {
    assert.equal(run.id, beforeSignoff.executionId)
    assert.equal(run.runtime_task_id, beforeSignoff.runtimeTaskId)
    assert.deepEqual(pipeline.stages, [sourceInstructions, pipelineReview])
  }
  assert.ok(
    !JSON.stringify(request).includes(privateSkill),
    'Personal Bot grants reached the project request'
  )
  const comments = await rpc('todos.comment.list', { project_id: project.id, task_id: issue.id })
  const receipts = comments.filter(
    row =>
      row.metadata.execution_id === run.id &&
      row.metadata.activity_type === 'manager_status_comment'
  )
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].sender_type, 'agent')
  assert.equal(receipts[0].sender_id, agentId)
  assert.equal(receipts[0].metadata.runtime_address.taskId, run.runtime_task_id)
  assert.ok(receipts[0].content.includes(expectedReceipt))
  const receiptRow = `${content} [data-message-id="${receipts[0].message_id}"]`
  await control.command('scrollIntoView', receiptRow)
  await control.command('waitFor', receiptRow, { text: expectedReceipt, timeoutMs: uiTimeoutMs })
  await control.command('waitFor', receiptRow, {
    text: group.members[0].name,
    timeoutMs: uiTimeoutMs,
  })
  await captureScreenshot(control, `${prefix}-10-project-agent-receipt.png`, content)
  await writeFile(
    join(
      resultDir,
      pipeline ? 'local-personal-team-pipeline.json' : 'local-personal-team-adoption.json'
    ),
    JSON.stringify(
      {
        source: { teamId: source.id, roleId, teamRef: sourceRef, ownerUserId: owner },
        beforeSignoff,
        modelStages: pipeline?.stages,
        projectId: project.id,
        groupId: group.id,
        groupVersion: group.version,
        members: group.members,
        issueId: issue.id,
        projectAgentId: agentId,
        execution: {
          id: run.id,
          assigner: run.assigner_user_id,
          agentId: run.agent_id,
          claimedAt: run.claimed_at,
          runtimeDeviceId: run.runtime_device_id,
          runtimeTaskId: run.runtime_task_id,
          status: run.status,
          teamRef: request.team_ref,
          bots: request.bot.map(({ id, name }) => ({ id, name })),
        },
        receipt: {
          messageId: receipts[0].message_id,
          senderType: receipts[0].sender_type,
          senderId: receipts[0].sender_id,
          runtimeTaskId: receipts[0].metadata.runtime_address.taskId,
          executionId: receipts[0].metadata.execution_id,
          content: receipts[0].content,
        },
      },
      null,
      2
    ) + '\n'
  )
}
