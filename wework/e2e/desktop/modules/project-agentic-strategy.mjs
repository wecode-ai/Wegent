import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { openDirectProjectCreation } from './workspace-flows.mjs'

const STAGES = [
  'requirement_intake',
  'joint_review',
  'development_preparation',
  'development_implementation',
  'quality_acceptance',
  'release_launch',
]
const LABELS = ['需求提出', '共同评审', '开发准备', '开发实现', '质量验收', '发布上线']

// This CI checkpoint creates its own policy project so later checks keep their original policy.
export async function verifyProjectAgenticStrategy(
  control,
  { scoped, request, project, owner, backendUrl, authToken }
) {
  const source = await readFile(
    new URL('../../../../docs/35-agentic-collaboration-strategy.md', import.meta.url),
    'utf8'
  )
  const strategyText = source.replace(
    /\b(zhongwei9|jiangyang7|hongyu9|jiaqi62|wenbo17|yunpeng7|sifang)\b/g,
    owner.user_name
  )
  const projectName = `协作策略验收-${Date.now()}`
  let policyProject = null
  let issue = null
  try {
    await openDirectProjectCreation(control, scoped(''))
    await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
      value: projectName,
    })
    await control.command('click', scoped('[data-testid="collaboration-project-create-confirm"]'))
    await control.command(
      'waitFor',
      scoped('[data-testid="collaboration-project-create-dialog"]'),
      { visible: false }
    )
    const projects = await request('/api/v1/cloud-projects')
    policyProject = projects.items.find(candidate => candidate.name === projectName)
    assert.ok(policyProject, 'The independent strategy project must persist')
    assert.equal(policyProject.agentic_strategy_enabled, true)
    assert.equal(policyProject.collaboration_strategy, null)
    await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
    await control.command(
      'click',
      scoped('[data-testid="collaboration-project-settings-strategy"]')
    )
    await control.command('fill', scoped('[data-testid="project-strategy-text"]'), {
      value: strategyText,
    })
    assert.equal(
      Number(
        await control.command('getElementCount', scoped('[data-testid="project-workflow-editor"]'))
      ),
      0
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          scoped('[data-testid^="project-workflow-dependency-"]')
        )
      ),
      0
    )
    await control.command('click', scoped('[data-testid="project-strategy-save"]'))
    await control.command('waitFor', scoped('[data-testid="project-strategy-saved"]'))
    const published = await request(`/api/v1/cloud-projects/${policyProject.id}`)
    const revision = published.collaboration_strategy
    assert.equal(revision.version, 1)
    assert.equal(revision.text, strategyText.trim())
    assert.equal(published.collaboration_strategy_versions.length, 1)
    assert.deepEqual(
      published.board_config.statuses.slice(1, 7).map(column => column.name),
      LABELS
    )
    assert.deepEqual(revision.role_mapping.pmo, [owner.user_name])

    issue = await request(`/api/v1/cloud-projects/${policyProject.id}/loop-items`, {
      method: 'POST',
      body: JSON.stringify({
        title: `策略准入验收-${Date.now()}`,
        description: 'Verify admission and evidence before moving.',
      }),
    })
    assert.equal(issue.status, 'inbox')
    assert.equal(issue.workflow.strategy_state, 'inbox')
    assert.deepEqual(issue.workflow.nodes, [])
    assert.ok(!issue.tags.some(tag => LABELS.includes(tag)))
    assert.deepEqual(await request(`/api/v1/loop-items/${issue.id}/tasks`), [])
    const incomplete = await fetch(`${backendUrl}/api/v1/loop-items/${issue.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: issue.version,
        workflow_action: { type: 'admit', idempotency_key: `admit-incomplete-${issue.id}` },
      }),
    })
    assert.equal(incomplete.status, 409)
    assert.match(await incomplete.text(), /objective|acceptance_criteria/)

    await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    await control.command('clickWhenEnabled', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`))
    for (const [field, value] of Object.entries({
      objective: 'Make stage decisions auditable',
      scope: 'Inbox admission and first stage',
      non_goals: 'Automatic deployment or child workspaces',
      acceptance_criteria: 'Incomplete definitions and missing evidence block progress',
      dependencies: 'none',
    })) {
      await control.command('fill', scoped(`[data-testid="issue-intake-${field}"]`), { value })
    }
    await control.command('select', scoped('[data-testid="issue-intake-proposed_owner"]'), {
      value: owner.user_name,
    })
    await control.command('select', scoped('[data-testid="issue-intake-priority"]'), {
      value: 'high',
    })
    await control.command('click', scoped('[data-testid="issue-intake-admit"]'))
    await control.command(
      'waitFor',
      scoped('[data-testid="todo-workflow-evidence-requirement_intake"]')
    )
    const admitted = await request(`/api/v1/loop-items/${issue.id}`)
    assert.equal(admitted.workflow.strategy_state, 'active')
    assert.equal(admitted.workflow.current_stage_id, STAGES[0])
    assert.equal(admitted.workflow.nodes[0].status, 'ready')
    assert.ok(admitted.workflow.nodes.slice(1).every(node => node.status === 'blocked'))
    assert.ok(admitted.tags.includes(LABELS[0]))
    const decision = {
      type: 'decide_node',
      node_id: STAGES[0],
      action: 'approve',
      idempotency_key: `evidence-retry-${issue.id}`,
    }
    const missing = await fetch(`${backendUrl}/api/v1/loop-items/${issue.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: admitted.version, workflow_action: decision }),
    })
    assert.equal(missing.status, 409)
    assert.match(await missing.text(), /missing_deliverables|acceptance_criteria/)
    await control.command(
      'click',
      scoped('[data-testid="todo-workflow-evidence-requirement_intake"]')
    )
    for (const requirement of admitted.workflow.nodes[0].required_deliverables) {
      assert.equal(requirement.value_type, 'text')
      await control.command(
        'fill',
        scoped(`[data-testid="workflow-deliverable-${requirement.id}-text"]`),
        {
          value: `${requirement.name}: verified by the isolated policy acceptance fixture.`,
        }
      )
    }
    await control.command('click', scoped('[data-testid="workflow-deliverables-submit"]'))
    await control.command('waitFor', scoped('[data-testid="workflow-deliverables-form"]'), {
      visible: false,
    })
    const withEvidence = await request(`/api/v1/loop-items/${issue.id}`)
    const approval = { version: withEvidence.version, workflow_action: decision }
    const advanced = await request(`/api/v1/loop-items/${issue.id}`, {
      method: 'PATCH',
      body: JSON.stringify(approval),
    })
    const repeated = await request(`/api/v1/loop-items/${issue.id}`, {
      method: 'PATCH',
      body: JSON.stringify(approval),
    })
    assert.equal(repeated.version, advanced.version)
    assert.deepEqual(repeated.workflow, advanced.workflow)
    assert.equal(advanced.workflow.nodes[0].status, 'completed')
    assert.equal(advanced.workflow.nodes[0].delivery_ids.length, 1)
    assert.equal(advanced.workflow.current_stage_id, STAGES[1])

    await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
    await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
    await control.command(
      'click',
      scoped('[data-testid="collaboration-project-settings-strategy"]')
    )
    await control.command('fill', scoped('[data-testid="project-strategy-text"]'), {
      value: `${strategyText}\n\n## 追踪补充\n阶段等待必须记录下一动作。`,
    })
    await control.command('click', scoped('[data-testid="project-strategy-save"]'))
    await control.command('waitFor', scoped('[data-testid="project-strategy-saved"]'))
    const second = await request(`/api/v1/cloud-projects/${policyProject.id}`)
    assert.equal(second.collaboration_strategy.version, 2)
    assert.equal(second.collaboration_strategy_versions.length, 2)
    assert.match(second.collaboration_strategy.diff, /追踪补充/)
    const unchanged = await request(`/api/v1/loop-items/${issue.id}`)
    assert.equal(unchanged.workflow.strategy_snapshot.version, 1)

    await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    await control.command('clickWhenEnabled', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`))
    await control.command('click', scoped('[data-testid="issue-strategy-evaluate"]'))
    await control.command('waitFor', scoped('[data-testid="issue-strategy-coordination-summary"]'))
    const evaluated = await request(`/api/v1/loop-items/${issue.id}`)
    assert.equal(evaluated.workflow.coordinator_decision.strategy_version, 1)
    assert.equal(evaluated.workflow.coordinator_decision.integration_status, 'pending_w0056')
    assert.ok(evaluated.workflow.coordinator_decision.evidence_refs.length > 0)
    await control.command('click', scoped('[data-testid="issue-strategy-upgrade"]'))
    await control.command('fill', scoped('[data-testid="todo-workflow-reason"]'), {
      value: 'Adopt the reviewed policy without rewriting completed work.',
    })
    await control.command('click', scoped('[data-testid="todo-workflow-confirm"]'))
    await control.command('waitFor', scoped('[data-testid="todo-workflow-reason"]'), {
      visible: false,
    })
    const upgraded = await request(`/api/v1/loop-items/${issue.id}`)
    assert.equal(upgraded.workflow.strategy_snapshot.version, 2)
    assert.equal(upgraded.workflow.nodes[0].status, 'completed')
    assert.deepEqual(
      upgraded.workflow.nodes[0].delivery_ids,
      advanced.workflow.nodes[0].delivery_ids
    )
    assert.equal(upgraded.workflow.strategy_upgrade_history.at(-1).from_version, 1)
    assert.equal(upgraded.workflow.strategy_upgrade_history.at(-1).to_version, 2)
  } finally {
    if (
      Number(
        await control.command('getElementCount', scoped('[data-testid="cloud-todo-detail-close"]'))
      ) > 0
    ) {
      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
    }
    await control.command(
      'click',
      scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`)
    )
    if (issue) await request(`/api/v1/loop-items/${issue.id}`, { method: 'DELETE' })
    if (policyProject) {
      const current = await request(`/api/v1/cloud-projects/${policyProject.id}`)
      await request(`/api/v1/cloud-projects/${policyProject.id}?version=${current.version}`, {
        method: 'DELETE',
      })
    }
  }
  await control.command('waitFor', scoped('[data-testid="collaboration-tab-board"]'))
}
