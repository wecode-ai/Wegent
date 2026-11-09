import { APIRequestContext } from '@playwright/test'
import { test, expect } from '../fixtures/test-fixtures'
import { ADMIN_USER } from '../config/test-users'
import { ApiClient, createApiClient } from '../utils/api-client'
import { DataBuilders } from '../fixtures/data-builders'

/**
 * Bot Shell identity isolation across the real hybrid gateway and database.
 *
 * `GET /api/bots` is served by Rust while Bot detail/update stay on Python, so
 * these scenarios assert both implementations agree on the Bot owner's Shell.
 */

const OWNER_password = 'Test@12345'

type BotSummary = {
  id: number
  name: string
  shell_name: string
  shell_type: string
}

type CreatedUser = { api: ApiClient; id: number }

async function loginAsAdmin(request: APIRequestContext): Promise<ApiClient> {
  const api = createApiClient(request)
  const login = await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)
  expect(login.status, JSON.stringify(login.data)).toBe(200)
  return api
}

async function createUser(
  request: APIRequestContext,
  admin: ApiClient,
  userName: string
): Promise<CreatedUser> {
  const created = await admin.adminCreateUser({
    user_name: userName,
    password: OWNER_password,
    role: 'user',
    auth_source: 'password',
  })
  expect(created.status, JSON.stringify(created.data)).toBe(201)
  const id = (created.data as { id: number }).id
  const api = createApiClient(request)
  const login = await api.login(userName, OWNER_password, 1)
  expect(login.status, JSON.stringify(login.data)).toBe(200)
  return { api, id }
}

async function createGroup(admin: ApiClient, name: string): Promise<void> {
  const response = await admin.createGroup({
    name,
    display_name: name,
    description: 'bot shell identity e2e',
    visibility: 'private',
  })
  expect(response.status, JSON.stringify(response.data)).toBe(201)
}

async function addGroupMember(
  admin: ApiClient,
  group: string,
  userId: number,
  role = 'Developer'
): Promise<void> {
  const response = await admin.addGroupMember(group, { user_id: userId, role })
  expect([200, 201], JSON.stringify(response.data)).toContain(response.status)
}

async function createShell(
  api: ApiClient,
  namespace: string,
  name: string,
  shellType: 'ClaudeCode' | 'Agno' | 'Dify' | 'Chat'
): Promise<void> {
  const shell = DataBuilders.shell({
    name,
    metadata: { name, namespace },
    spec: {
      shellType,
      description: 'bot shell identity e2e',
      baseImage: 'python:3.11',
      supportModel: [],
    },
  })
  const response = await api.post(`/api/v1/namespaces/${namespace}/shells`, shell)
  expect([200, 201], JSON.stringify(response.data)).toContain(response.status)
}

async function createBot(
  api: ApiClient,
  name: string,
  namespace: string,
  shellName: string
): Promise<BotSummary> {
  const response = await api.createBot({
    name,
    shell_name: shellName,
    agent_config: {},
    system_prompt: 'Original prompt',
    mcp_servers: {},
    namespace,
  })
  expect(response.status, JSON.stringify(response.data)).toBe(201)
  return response.data as BotSummary
}

async function findListedBot(
  api: ApiClient,
  group: string,
  botId: number
): Promise<BotSummary | undefined> {
  const response = await api.getBots('group', group)
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return (response.data as { items: BotSummary[] }).items.find(item => item.id === botId)
}

async function readBotNamespace(api: ApiClient, namespace: string, name: string) {
  const response = await api.get(`/api/v1/namespaces/${namespace}/bots/${name}`)
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return (response.data as { spec: { shellRef: { namespace: string } } }).spec.shellRef.namespace
}

async function cleanup(
  admin: ApiClient,
  owners: CreatedUser[],
  works: {
    team?: { id: number; name: string }
    bots?: Array<{ api: ApiClient; id: number }>
    shells?: Array<{ api: ApiClient; namespace: string; name: string }>
    groups?: string[]
    users?: CreatedUser[]
  }
): Promise<void> {
  if (works.team) {
    await admin.delete(
      `/api/teams/${works.team.id}?${new URLSearchParams({
        force: 'true',
        confirm_name: works.team.name,
      })}`
    )
  }
  for (const bot of works.bots ?? []) await bot.api.delete(`/api/bots/${bot.id}`)
  for (const shell of works.shells ?? []) {
    await shell.api.delete(`/api/v1/namespaces/${shell.namespace}/shells/${shell.name}`)
  }
  for (const group of works.groups ?? []) await admin.deleteGroup(group)
  for (const user of works.users ?? owners) await admin.adminDeleteUser(user.id)
}

test('group list and detail report the Bot owner shell, not the viewer shell', async ({
  request,
  testPrefix,
}) => {
  const admin = await loginAsAdmin(request)
  const owner = await createUser(request, admin, `${testPrefix}-owner`)
  const group = `${testPrefix}-bots`
  const shellName = `${testPrefix}-shell`
  const botName = `${testPrefix}-bot`
  const created: Array<{ api: ApiClient; id: number }> = []
  try {
    await createGroup(admin, group)
    await addGroupMember(admin, group, owner.id)
    await createShell(owner.api, 'default', shellName, 'ClaudeCode')
    await createShell(admin, 'default', shellName, 'Chat')
    const bot = await createBot(owner.api, botName, group, shellName)
    created.push({ api: owner.api, id: bot.id })

    const listed = await findListedBot(admin, group, bot.id)
    expect(listed, `bot ${bot.id} must be listed for the group viewer`).toBeDefined()
    expect(listed?.shell_type).toBe('ClaudeCode')

    const detail = await admin.get(`/api/bots/${bot.id}`)
    expect(detail.status, JSON.stringify(detail.data)).toBe(200)
    expect((detail.data as BotSummary).shell_type).toBe('ClaudeCode')
  } finally {
    await cleanup(admin, [owner], {
      bots: created,
      shells: [
        { api: owner.api, namespace: 'default', name: shellName },
        { api: admin, namespace: 'default', name: shellName },
      ],
      groups: [group],
    })
  }
})

test('unauthorized owners do not inherit a same-key group shell from another owner', async ({
  request,
  testPrefix,
}) => {
  const admin = await loginAsAdmin(request)
  const owner = await createUser(request, admin, `${testPrefix}-owner`)
  const group = `${testPrefix}-bots`
  const shellGroup = `${testPrefix}-shells`
  const shellName = `${testPrefix}-group-shell`
  const created: Array<{ api: ApiClient; id: number }> = []
  try {
    await createGroup(admin, group)
    await createGroup(admin, shellGroup)
    await addGroupMember(admin, group, owner.id)
    await addGroupMember(admin, shellGroup, owner.id)
    await createShell(admin, shellGroup, shellName, 'Agno')

    const ownerBot = await createBot(owner.api, `${testPrefix}-owner-bot`, group, shellName)
    const adminBot = await createBot(admin, `${testPrefix}-admin-bot`, group, shellName)
    created.push({ api: owner.api, id: ownerBot.id }, { api: admin, id: adminBot.id })

    const removed = await admin.removeGroupMember(shellGroup, owner.id)
    expect([200, 204], JSON.stringify(removed.data)).toContain(removed.status)

    const adminItem = await findListedBot(admin, group, adminBot.id)
    const ownerItem = await findListedBot(admin, group, ownerBot.id)
    expect(adminItem?.shell_type).toBe('Agno')
    expect(ownerItem).toBeDefined()
    expect(ownerItem?.shell_type).not.toBe('Agno')

    const ownerDetail = await admin.get(`/api/bots/${ownerBot.id}`)
    expect(ownerDetail.status, JSON.stringify(ownerDetail.data)).toBe(200)
    expect((ownerDetail.data as BotSummary).shell_type).not.toBe('Agno')
  } finally {
    await cleanup(admin, [owner], {
      bots: created,
      shells: [{ api: admin, namespace: shellGroup, name: shellName }],
      groups: [group, shellGroup],
    })
  }
})

test('a collaborator prompt-only save keeps shellRef namespace, type and team members', async ({
  request,
  testPrefix,
}) => {
  const admin = await loginAsAdmin(request)
  const owner = await createUser(request, admin, `${testPrefix}-collaborator`)
  const outsider = await createUser(request, admin, `${testPrefix}-outsider`)
  const group = `${testPrefix}-bots`
  const shellGroup = `${testPrefix}-shells`
  const shellName = `${testPrefix}-group-shell`
  const teamName = `${testPrefix}-team`
  const memberName = `${testPrefix}-member-bot`
  const leaderName = `${testPrefix}-leader-bot`
  const created: Array<{ api: ApiClient; id: number }> = []
  let teamId: number | undefined
  try {
    await createGroup(admin, group)
    await createGroup(admin, shellGroup)
    await addGroupMember(admin, group, owner.id)
    await createShell(admin, shellGroup, shellName, 'Agno')
    const member = await createBot(admin, memberName, group, shellName)
    const leader = await createBot(admin, leaderName, group, shellName)
    created.push({ api: admin, id: member.id }, { api: admin, id: leader.id })

    const team = await admin.createTeam({
      name: teamName,
      namespace: group,
      workflow: { mode: 'pipeline', leader_bot_id: leader.id },
      bots: [
        { bot_id: leader.id, role: 'leader', bot_prompt: '' },
        { bot_id: member.id, role: 'member', bot_prompt: '' },
      ],
      bind_mode: ['code', 'task'],
    })
    expect(team.status, JSON.stringify(team.data)).toBe(201)
    teamId = (team.data as { id: number }).id

    const saved = await owner.api.put(`/api/bots/${member.id}`, {
      name: memberName,
      shell_name: shellName,
      system_prompt: 'Prompt updated by the collaborator.',
    })
    expect(saved.status, JSON.stringify(saved.data)).toBe(200)
    expect((saved.data as BotSummary).shell_type).toBe('Agno')

    expect(await readBotNamespace(admin, group, memberName)).toBe(shellGroup)
    const detail = await admin.get(`/api/bots/${member.id}`)
    expect(detail.status, JSON.stringify(detail.data)).toBe(200)
    expect((detail.data as BotSummary).shell_type).toBe('Agno')

    const persistedTeam = await admin.get<{ bots: Array<{ bot_id: number }> }>(
      `/api/teams/${teamId}`
    )
    expect(persistedTeam.status, JSON.stringify(persistedTeam.data)).toBe(200)
    expect(persistedTeam.data?.bots.map(bot => bot.bot_id)).toEqual([leader.id, member.id])

    const rejected = await outsider.api.put(`/api/bots/${member.id}`, {
      name: memberName,
      shell_name: shellName,
      system_prompt: 'Outsider edit must not apply.',
    })
    expect(rejected.status, JSON.stringify(rejected.data)).toBe(403)
  } finally {
    await cleanup(admin, [owner, outsider], {
      team: teamId === undefined ? undefined : { id: teamId, name: teamName },
      bots: created,
      shells: [{ api: admin, namespace: shellGroup, name: shellName }],
      groups: [group, shellGroup],
    })
  }
})

test('an invalidated group reference falls back publicly and persists the fallback namespace', async ({
  request,
  testPrefix,
}) => {
  const admin = await loginAsAdmin(request)
  const owner = await createUser(request, admin, `${testPrefix}-owner`)
  const group = `${testPrefix}-bots`
  const shellGroup = `${testPrefix}-shells`
  const shellName = 'ClaudeCode'
  const botName = `${testPrefix}-bot`
  const created: Array<{ api: ApiClient; id: number }> = []
  try {
    await createGroup(admin, group)
    await createGroup(admin, shellGroup)
    await addGroupMember(admin, group, owner.id)
    await addGroupMember(admin, shellGroup, owner.id)
    await createShell(admin, shellGroup, shellName, 'Agno')
    const bot = await createBot(owner.api, botName, group, shellName)
    created.push({ api: owner.api, id: bot.id })
    expect(bot.shell_type).toBe('Agno')
    expect(await readBotNamespace(owner.api, group, botName)).toBe(shellGroup)

    const removed = await admin.delete(`/api/v1/namespaces/${shellGroup}/shells/${shellName}`)
    expect([200, 204], JSON.stringify(removed.data)).toContain(removed.status)

    const fallback = await owner.api.get(`/api/bots/${bot.id}`)
    expect(fallback.status, JSON.stringify(fallback.data)).toBe(200)
    expect((fallback.data as BotSummary).shell_type).toBe('ClaudeCode')
    expect(await readBotNamespace(owner.api, group, botName)).toBe(shellGroup)

    const saved = await owner.api.put(`/api/bots/${bot.id}`, {
      name: botName,
      shell_name: shellName,
      system_prompt: 'Re-save after the group shell was removed.',
    })
    expect(saved.status, JSON.stringify(saved.data)).toBe(200)
    expect((saved.data as BotSummary).shell_type).toBe('ClaudeCode')
    expect(await readBotNamespace(owner.api, group, botName)).toBe('default')

    const persisted = await owner.api.get(`/api/bots/${bot.id}`)
    expect(persisted.status, JSON.stringify(persisted.data)).toBe(200)
    expect((persisted.data as BotSummary).shell_type).toBe('ClaudeCode')
  } finally {
    await cleanup(admin, [owner], { bots: created, groups: [group, shellGroup] })
  }
})
