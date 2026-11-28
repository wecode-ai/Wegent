import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fetchJson } from './shared.mjs'

export async function createPersonalTeamCloudAdoption(cloud, userId, model) {
  const id = randomUUID()
  const label = 'personal-matrix-' + id.slice(0, 8)
  const root = { id, name: label, leadId: 'personal-codex-coordinate', members: {} }
  const members = {}
  const request = (path, method = 'GET', data) =>
    fetchJson(cloud.backendUrl + path, {
      method,
      headers: { Authorization: 'Bearer ' + cloud.authToken, 'content-type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    })
  const workspace = await request('/api/v1/workspaces', 'POST', { name: label })
  const project = await request('/api/v1/workspaces/' + workspace.id + '/projects', 'POST', {
    name: label,
    task_provider: 'local',
    visibility: 'private',
  })
  const projectPath = '/api/v1/cloud-projects/' + project.id
  return {
    root,
    async createSource(roleId, mode, bots) {
      const name = label + '-' + mode
      const created = []
      for (const bot of bots) {
        const saved = await request('/api/bots', 'POST', {
          name: name + '-' + bot.name,
          namespace: 'default',
          shell_name: 'Codex',
          system_prompt: bot.system_prompt,
          agent_config: { bind_model: model.name, bind_model_type: model.type },
        })
        created.push({ ...bot, id: saved.id, name: saved.name })
      }
      const team = await request('/api/teams', 'POST', {
        name,
        namespace: 'default',
        workflow: { mode, leader_bot_id: created[0].id },
        bots: created.map(bot => ({
          bot_id: bot.id,
          role: bot.role,
          contextPassing: bot.contextPassing ?? 'none',
        })),
      })
      assert.equal(team.user_id, userId)
      const actor = await request(projectPath + '/chat-agents', 'POST', {
        name,
        runtime: 'wegent',
        wegent_team_id: team.id,
        share_with_workspace: true,
      })
      const stored = await request('/api/teams/' + team.id)
      assert.deepEqual(
        stored.bots.map(bot => bot.bot_id),
        created.map(bot => bot.id)
      )
      const definition = {
        name,
        collaboration_model: mode,
        bot: created.map((bot, index) => ({
          id: bot.id,
          name: bot.name,
          role: stored.bots[index].role,
          shell_type: 'Codex',
          system_prompt: bot.system_prompt,
          prompt: stored.bots[index].bot_prompt ?? '',
          require_confirmation: stored.bots[index].requireConfirmation,
          context_passing: stored.bots[index].contextPassing,
        })),
      }
      members[roleId] = { teamId: team.id, projectAgentId: actor.id, definition }
      root.members[roleId] =
        mode === 'pipeline' ? 'Review both release stages' : 'Coordinate release verification'
      return definition
    },
    async adopt(roles) {
      const sources = Object.entries(members)
      assert.equal(sources.length, 2)
      const binding = {
        root: { kind: 'team', definition: root },
        member_agent_ids: Object.fromEntries(sources.map(([role, m]) => [role, m.projectAgentId])),
        member_team_definitions: Object.fromEntries(
          sources.map(([role, m]) => [role, m.definition])
        ),
      }
      const adoption = await request(projectPath + '/personal-team-bindings/' + id, 'PUT', binding)
      const groups = await request(projectPath + '/collaboration-groups')
      const group = groups.items.find(item => item.id === adoption.group_id)
      assert.equal(group.personal_team_managed, true)
      assert.equal(group.leader.id, members[root.leadId].projectAgentId)
      assert.deepEqual(
        group.members.map(m => m.id).sort(),
        Object.values(binding.member_agent_ids).sort()
      )
      const agents = await request(projectPath + '/chat-agents')
      for (const [role, source] of sources) {
        assert.equal(agents.find(a => a.id === source.projectAgentId)?.wegentTeamId, source.teamId)
        assert.deepEqual(
          roles.find(r => r.id === role).boundBots.map(b => b.id),
          source.definition.bot.map(b => b.id)
        )
      }
      return {
        ownerUserId: userId,
        projectId: project.id,
        groupId: group.id,
        root,
        sources: members,
      }
    },
  }
}
