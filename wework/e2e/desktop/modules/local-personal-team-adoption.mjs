import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from './executor-rpc.mjs'
import { disconnectDesktopCloud } from './desktop-cloud-login.mjs'
import { standInRoleFixture } from './stand-in-role-fixture.mjs'
import { selectCollaborationProjectView } from './collaboration-project-navigation.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

const roleId = 'release-review'
const privateSkill = 'personal-release-approval'
export const adoptedIssue = '核验本地采用团队的签收'
export const sourceInstructions = '核验本地采用来源的签收编号'
export const adoptedReceipt = '项目虚拟成员已核验采用团队的签收编号'

export async function verifyLocalPersonalTeamAdoption(
  control,
  {
    content,
    projectName,
    agentId,
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
  await disconnectDesktopCloud(control)
  await click('settings-back-button')
  await click('workspace-tab-select-fixed-board')
  const owner = 0
  const profile = await rpc('runtime.stand_in.personal.get', { userId: owner })
  const source = {
    id: randomUUID(),
    name: '本地采用验收团队',
    leadId: roleId,
    members: { [roleId]: '核验交付' },
  }
  const role = {
    ...standInRoleFixture(profile.executionDeviceId, roleId),
    name: '签收助理',
    enabled: true,
    migrationSource: JSON.stringify(['source-device', owner, roleId]),
  }
  const settings = await rpc('runtime.stand_in.personal.save', {
    userId: owner,
    transferRoleId: roleId,
    portableTeam: {
      name: role.name,
      collaboration_model: 'solo',
      bot: [{ id: 51, name: 'Reviewer', shell_type: 'Codex', system_prompt: sourceInstructions }],
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
    ownedTeam: { roleId, botGrants: [{ id: 51, skills: [privateSkill] }] },
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
  for (let attempt = 0; attempt < 2; attempt++) {
    await click('project-personal-team-open')
    await click('project-personal-team-select')
    await click(`project-personal-team-select-option-${source.id}`)
    await click(`project-personal-team-member-${roleId}`)
    await click(`project-personal-team-member-${roleId}-option-${agentId}`)
    if (attempt === 0)
      await captureScreenshot(control, 'local-coordinate-08-personal-team-mapping.png', content)
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
  await assignIssue(adoptedIssue, source.name, '请核验项目交付并回复签收编号。')
  await captureScreenshot(control, 'local-coordinate-09-adopted-group-assignee.png', content)
  await control.command('waitFor', `${content} [data-testid="cloud-task-activity-list"]`, {
    text: adoptedReceipt,
    timeoutMs: modelResponseTimeoutMs,
  })
  const issue = (await rpc('todos.list', { project_id: project.id })).find(
    row => row.title === adoptedIssue
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
  assert.equal(run.agent_id, agentId)
  assert.ok(run.claimed_at && run.runtime_device_id && run.runtime_task_id)
  const request = run.runtime_payload.executionRequest
  assert.equal(request.team_ref, agentId)
  assert.equal(request.bot[0].id, 51)
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
  assert.ok(receipts[0].content.includes(adoptedReceipt))
  await captureScreenshot(control, 'local-coordinate-10-project-agent-receipt.png', content)
  await writeFile(
    join(resultDir, 'local-personal-team-adoption.json'),
    JSON.stringify(
      {
        source: { teamId: source.id, roleId, teamRef: sourceRef, ownerUserId: owner },
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
          executionId: receipts[0].metadata.execution_id,
          content: receipts[0].content,
        },
      },
      null,
      2
    ) + '\n'
  )
}
