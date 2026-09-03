import { describe, expect, test, vi } from 'vitest'
import { createProjectApi } from './projects'
import { createDeviceApi } from './devices'
import { createSystemSkillApi } from './systemSkills'
import { createTeamApi } from './teams'
import { createModelApi } from './models'
import { createSkillApi } from './skills'
import { createPluginApi } from './plugins'
import type { HttpClient } from './http'

function mockClient(): HttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }
}

describe('REST adapters', () => {
  test('loads projects without DB tasks included', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ items: [] })

    await createProjectApi(client).listProjects()

    expect(client.get).toHaveBeenCalledWith('/projects?client_origin=wework')
  })

  test('creates Git workspace projects from the wework client origin', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({
      project: { id: 9, name: 'Wegent' },
      checkout_path: 'Wegent',
      reused_existing_checkout: false,
    })

    await createProjectApi(client).createGitWorkspaceProject({
      device_id: 'device-1',
      name: 'Wegent',
      git: {
        url: 'https://github.com/wecode-ai/Wegent.git',
        repo: 'wecode-ai/Wegent',
        repoId: 101,
        domain: 'github.com',
        branch: 'main',
      },
    })

    expect(client.post).toHaveBeenCalledWith('/projects/git-workspace', {
      device_id: 'device-1',
      name: 'Wegent',
      client_origin: 'wework',
      git: {
        url: 'https://github.com/wecode-ai/Wegent.git',
        repo: 'wecode-ai/Wegent',
        repoId: 101,
        domain: 'github.com',
        branch: 'main',
      },
    })
  })

  test('loads Wework project worktrees from the project adapter', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ total: 0, devices: [] })

    await createProjectApi(client).listWorktrees()

    expect(client.get).toHaveBeenCalledWith('/projects/worktrees?client_origin=wework')
  })

  test('deletes Wework project worktrees from the project adapter', async () => {
    const client = mockClient()
    vi.mocked(client.delete).mockResolvedValueOnce({
      worktree_id: '1386',
      path: '/workspace/worktrees/1386/Wegent',
      deleted_task_ids: [1288],
    })

    await createProjectApi(client).deleteWorktree({
      device_id: 'device-1',
      worktree_id: '1386',
      project_id: 7,
    })

    expect(client.delete).toHaveBeenCalledWith(
      '/projects/worktrees/device-1/1386?project_id=7&client_origin=wework'
    )
  })

  test('lists persisted Wegent teams without inferring a Wework default', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({
      total: 3,
      items: [
        { id: 1, name: 'general', default_for_modes: ['chat'], is_active: true },
        { id: 2, name: 'coder', default_for_modes: ['code'], is_active: true },
        { id: 3, name: 'wework', default_for_modes: ['wework'], is_active: true },
      ],
    })

    const teams = await createTeamApi(client).listTeams()

    expect(teams.map(team => team.id)).toEqual([1, 2, 3])
  })

  test('loads system skills with search params', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({
      total: 0,
      page: 1,
      pageSize: 20,
      items: [],
      providerErrors: [],
    })

    await createSystemSkillApi(client).listSystemSkills({
      providerKey: 'builtin',
      keyword: 'image',
      tags: ['system', 'image'],
      page: 1,
      pageSize: 20,
    })

    expect(client.get).toHaveBeenCalledWith(
      '/system-skills?category=system&page=1&pageSize=20&providerKey=builtin&keyword=image&tags=system%2Cimage'
    )
  })

  test('installs, toggles, and uninstalls system skills', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({})
    vi.mocked(client.put).mockResolvedValueOnce({})
    vi.mocked(client.delete).mockResolvedValueOnce({})
    const api = createSystemSkillApi(client)

    await api.installSystemSkill({
      providerKey: 'weibo',
      skillKey: 'wehot',
      catalogItemId: '@weibo/shitao7_wehot',
      displayName: 'wehot',
      description: 'Weibo hot search',
      version: '1.0.0',
      tags: ['weibo'],
    })
    await api.updateInstalledSystemSkill(42, false)
    await api.uninstallInstalledSystemSkill(42)
    await api.installPersonalSkill(77)
    await api.updatePersonalSkillEnabled(77, false)

    expect(client.post).toHaveBeenCalledWith('/system-skills/install', {
      providerKey: 'weibo',
      skillKey: 'wehot',
      catalogItemId: '@weibo/shitao7_wehot',
      displayName: 'wehot',
      description: 'Weibo hot search',
      version: '1.0.0',
      tags: ['weibo'],
    })
    expect(client.put).toHaveBeenCalledWith('/system-skills/installed/42', {
      enabled: false,
    })
    expect(client.post).toHaveBeenCalledWith('/system-skills/install/personal', {
      skillId: 77,
    })
    expect(client.put).toHaveBeenCalledWith('/v1/kinds/skills/77/enabled', {
      enabled: false,
    })
    expect(client.delete).toHaveBeenCalledWith('/system-skills/installed/42')
  })

  test('loads unified llm models from existing backend endpoint', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ data: [] })

    await createModelApi(client).listModels()

    expect(client.get).toHaveBeenCalledWith(
      '/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework'
    )
  })

  test('loads unified skills and team skills from existing backend endpoints', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValue({ items: [] })

    await createSkillApi(client).listSkills()
    await createSkillApi(client).getTeamSkills(2)

    expect(client.get).toHaveBeenNthCalledWith(1, '/v1/kinds/skills/unified?scope=all')
    expect(client.get).toHaveBeenNthCalledWith(2, '/teams/2/skills')
  })

  test('searches both departments and the organization root for plugin sharing', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ items: [], total: 0 })

    await createPluginApi(client).searchPluginShareGroups('研发 部')

    expect(client.get).toHaveBeenCalledWith(
      '/groups/search?q=%E7%A0%94%E5%8F%91%20%E9%83%A8&limit=20&include_organization=true'
    )
  })

  test('lists and withdraws independent plugin publication requests', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 })
    vi.mocked(client.post).mockResolvedValueOnce({ id: 82, aggregateStatus: 'withdrawn' })
    const api = createPluginApi(client)

    await api.listPublicationRequests({
      sourcePluginId: 101,
      activeOnly: true,
      page: 1,
      limit: 20,
    })
    await api.getPublicationRequest(82, 1)
    await api.withdrawPublicationRequest(82, 3)

    expect(client.get).toHaveBeenCalledWith(
      '/plugins/publication-requests?sourcePluginId=101&activeOnly=true&page=1&limit=20'
    )
    expect(client.get).toHaveBeenCalledWith('/plugins/publication-requests/82?revision=1')
    expect(client.post).toHaveBeenCalledWith(
      '/plugins/publication-requests/82/withdraw',
      undefined,
      {
        headers: { 'Idempotency-Key': 'plugin-publication-withdraw-82-r3' },
      }
    )
  })

  test('uploads one immutable snapshot before completing a publication request', async () => {
    const client = mockClient()
    vi.mocked(client.post)
      .mockResolvedValueOnce({
        requestId: 82,
        sourcePluginId: 101,
        revision: { number: 2 },
        uploadUrl: 'https://upload.example.com/request-82-r2.zip',
        expiresAt: '2026-08-29T10:00:00Z',
      })
      .mockResolvedValueOnce({ id: 82, sourcePluginId: 101 })
    const upload = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', upload)

    try {
      const file = new File(['zip snapshot'], 'dev-tools.zip', {
        type: 'application/zip',
      })
      await createPluginApi(client).publishPublicationRequest(
        file,
        {
          sourcePluginId: 101,
          slug: 'dev-tools',
          displayName: 'Dev Tools',
          requestedVersion: '1.2.0',
          releaseNotes: 'Enterprise release',
          testNotes: 'Windows and macOS passed',
          riskDeclaration: { externalNetwork: false },
        },
        'attempt-create-1'
      )

      expect(client.post).toHaveBeenNthCalledWith(
        1,
        '/plugins/publication-requests',
        expect.objectContaining({
          sourcePluginId: 101,
          filename: 'dev-tools.zip',
          sizeBytes: file.size,
          snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        {
          headers: {
            'Idempotency-Key': expect.stringMatching(
              /^plugin-publication-create-attempt-create-1-[a-f0-9]+$/
            ),
          },
        }
      )
      expect(upload).toHaveBeenCalledWith('https://upload.example.com/request-82-r2.zip', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      })
      expect(client.post).toHaveBeenNthCalledWith(
        2,
        '/plugins/publication-requests/82/revisions/2/complete',
        undefined,
        {
          headers: {
            'Idempotency-Key': expect.stringMatching(
              /^plugin-publication-complete-82-r2-[a-f0-9]{64}$/
            ),
          },
        }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('uploads a new revision into the existing publication request', async () => {
    const client = mockClient()
    vi.mocked(client.post)
      .mockResolvedValueOnce({
        requestId: 82,
        sourcePluginId: 101,
        revision: { number: 3 },
        uploadUrl: 'https://upload.example.com/request-82-r3.zip',
        expiresAt: '2026-08-29T10:00:00Z',
      })
      .mockResolvedValueOnce({ id: 82, pluginId: 101, currentRevision: 3 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 }))
    )

    try {
      await createPluginApi(client).publishPublicationRevision(
        82,
        new File(['revision 3'], 'dev-tools.zip', { type: 'application/zip' }),
        {
          requestedVersion: '1.3.0',
          releaseNotes: 'Address review feedback',
          testNotes: 'Windows and macOS passed',
          riskDeclaration: { externalNetworkAccess: false },
        },
        'attempt-revision-1'
      )

      expect(client.post).toHaveBeenNthCalledWith(
        1,
        '/plugins/publication-requests/82/revisions',
        expect.objectContaining({ requestedVersion: '1.3.0' }),
        {
          headers: {
            'Idempotency-Key': expect.stringMatching(
              /^plugin-publication-revision-82-attempt-revision-1-[a-f0-9]+$/
            ),
          },
        }
      )
      expect(client.post).toHaveBeenNthCalledWith(
        2,
        '/plugins/publication-requests/82/revisions/3/complete',
        undefined,
        {
          headers: {
            'Idempotency-Key': expect.stringMatching(
              /^plugin-publication-complete-82-r3-[a-f0-9]{64}$/
            ),
          },
        }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('binds the create idempotency key to both the logical attempt and full metadata', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockRejectedValue(new Error('transport unavailable'))
    const api = createPluginApi(client)
    const file = new File(['same snapshot'], 'dev-tools.zip', { type: 'application/zip' })
    const baseMetadata = {
      sourcePluginId: 101,
      slug: 'dev-tools',
      displayName: 'Dev Tools',
      requestedVersion: '1.2.0',
      releaseNotes: 'First release notes',
      testNotes: 'Windows and macOS passed',
      riskDeclaration: { externalNetworkAccess: false },
    }

    await expect(
      api.publishPublicationRequest(file, baseMetadata, 'logical-attempt-a')
    ).rejects.toThrow('transport unavailable')
    await expect(
      api.publishPublicationRequest(file, baseMetadata, 'logical-attempt-a')
    ).rejects.toThrow('transport unavailable')
    await expect(
      api.publishPublicationRequest(
        file,
        { ...baseMetadata, releaseNotes: 'Changed release notes' },
        'logical-attempt-a'
      )
    ).rejects.toThrow('transport unavailable')
    await expect(
      api.publishPublicationRequest(file, baseMetadata, 'logical-attempt-b')
    ).rejects.toThrow('transport unavailable')

    const keys = vi
      .mocked(client.post)
      .mock.calls.map(call => String(call[2]?.headers?.['Idempotency-Key']))
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
    expect(keys[3]).not.toBe(keys[0])
  })

  test('withdraws a publication request when a new revision upload fails', async () => {
    const client = mockClient()
    vi.mocked(client.post)
      .mockResolvedValueOnce({
        requestId: 82,
        sourcePluginId: 101,
        revision: { number: 3 },
        uploadUrl: 'https://upload.example.com/request-82-r3.zip',
        expiresAt: '2026-08-29T10:00:00Z',
      })
      .mockResolvedValueOnce({ id: 82, aggregateStatus: 'withdrawn' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 }))
    )

    try {
      await expect(
        createPluginApi(client).publishPublicationRevision(
          82,
          new File(['revision 3'], 'dev-tools.zip', { type: 'application/zip' }),
          {
            requestedVersion: '1.3.0',
            releaseNotes: 'Address review feedback',
            testNotes: 'Windows and macOS passed',
            riskDeclaration: { externalNetworkAccess: false },
          },
          'attempt-revision-upload-failure'
        )
      ).rejects.toThrow('Plugin upload failed with HTTP 500')

      expect(client.post).toHaveBeenNthCalledWith(
        2,
        '/plugins/publication-requests/82/withdraw',
        undefined,
        {
          headers: { 'Idempotency-Key': 'plugin-publication-withdraw-82-r3' },
        }
      )
      expect(client.post).not.toHaveBeenCalledWith(
        '/plugins/publication-requests/82/revisions/3/complete',
        expect.anything(),
        expect.anything()
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('resolves plugin submission uploads against the connected Backend', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({
      submissionId: 17,
      pluginId: 4,
      releaseId: 8,
      uploadUrl: '/api/plugins/submissions/17/artifact?token=ticket',
      expiresAt: '2026-09-02T12:00:00Z',
    })

    const initialized = await createPluginApi(
      client,
      'https://api.example.test/api'
    ).initSubmission({
      slug: 'example',
      displayName: 'Example',
      version: '1.0.0',
      filename: 'example.zip',
      sha256: '0'.repeat(64),
      sizeBytes: 3,
    })

    expect(initialized.uploadUrl).toBe(
      'https://api.example.test/api/plugins/submissions/17/artifact?token=ticket'
    )
  })

  test('ensures a built-in plugin through its stable key', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({ plugin: {} })

    await createPluginApi(client).ensureBuiltinPluginInstalled('wegent-sites', {
      deviceId: 'device-1',
    })

    expect(client.post).toHaveBeenCalledWith('/plugins/builtin/wegent-sites/ensure-installed', {
      device_id: 'device-1',
    })
  })

  test('ensures a built-in plugin without requiring a target device', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({ plugin: {} })

    await createPluginApi(client).ensureBuiltinPluginInstalled('wegent-sites')

    expect(client.post).toHaveBeenCalledWith('/plugins/builtin/wegent-sites/ensure-installed', {})
  })

  test('reports locally present plugins without syncing packages', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({
      deviceId: 'device-1',
      acknowledgedCount: 2,
      acknowledgedInstalledPluginIds: [101, 202],
    })

    await createPluginApi(client).reportInstalledPluginsOnDevice('device-1', [
      { installedPluginId: 101, releaseId: 1001, version: '1.0.0' },
      { installedPluginId: 202, releaseId: 2001, version: '2.0.0' },
    ])

    expect(client.post).toHaveBeenCalledWith(
      '/plugins/installed/report-device?device_id=device-1',
      {
        plugins: [
          { installedPluginId: 101, releaseId: 1001, version: '1.0.0' },
          { installedPluginId: 202, releaseId: 2001, version: '2.0.0' },
        ],
      }
    )
  })

  test('starts project-scoped terminal and IDE sessions', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValue({ url: 'http://localhost/session' })

    const api = createProjectApi(client)

    await api.startTerminalSession(7)
    await api.startCodeServerSession(7)

    expect(client.post).toHaveBeenNthCalledWith(1, '/projects/7/terminal?client_origin=wework')
    expect(client.post).toHaveBeenNthCalledWith(2, '/projects/7/code-server?client_origin=wework')
  })

  test('resolves device home and project workspace root', async () => {
    const client = mockClient()
    vi.mocked(client.post)
      .mockResolvedValueOnce({
        success: true,
        stdout: '/home/ubuntu\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '/workspace/projects\n',
        stderr: '',
      })

    const api = createDeviceApi(client)

    await expect(api.getHomeDirectory('device-1')).resolves.toBe('/home/ubuntu')
    await expect(api.getProjectWorkspaceRoot('device-1')).resolves.toBe('/workspace/projects')

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/devices/device-1/commands',
      expect.objectContaining({ command_key: 'home_dir' })
    )
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/devices/device-1/commands',
      expect.objectContaining({ command_key: 'project_workspace_root' })
    )
  })

  test('creates a directory through the device command API', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({
      success: true,
      stdout: '',
      stderr: '',
    })

    const api = createDeviceApi(client)

    await expect(
      api.createDirectory('device-1', '  /home/ubuntu/new-app  ')
    ).resolves.toBeUndefined()

    expect(client.post).toHaveBeenCalledWith(
      '/devices/device-1/commands',
      expect.objectContaining({
        command_key: 'mkdir_p',
        args: ['/home/ubuntu/new-app'],
      })
    )
  })

  test('rejects blank directory paths before calling the device command API', async () => {
    const client = mockClient()
    const api = createDeviceApi(client)

    await expect(api.createDirectory('device-1', '   ')).rejects.toThrow(
      'Directory path is required'
    )
    expect(client.post).not.toHaveBeenCalled()
  })

  test('throws backend command errors when directory creation fails', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({
      success: false,
      stdout: '',
      stderr: 'mkdir failed',
    })

    const api = createDeviceApi(client)

    await expect(api.createDirectory('device-1', '/home/ubuntu/new-app')).rejects.toThrow(
      'mkdir failed'
    )
  })

  test('loads local device skills through the device command API', async () => {
    const client = mockClient()
    const skills = [
      {
        name: 'zeta',
        description: 'Zeta skill',
        path: '/Users/crystal/.codex/skills/zeta/SKILL.md',
        source: 'codex',
      },
      {
        name: 'Dws',
        description: 'DingTalk skill from Claude',
        path: '/Users/crystal/.claude/skills/dws/SKILL.md',
        source: 'claude',
      },
      {
        name: 'dws',
        description: 'DingTalk skill from Codex',
        path: '/Users/crystal/.codex/skills/dws/SKILL.md',
        source: 'codex',
      },
      {
        name: 'alpha',
        description: 'Alpha skill',
        path: '/Users/crystal/.codex/skills/alpha/SKILL.md',
        source: 'codex',
      },
    ]
    vi.mocked(client.post).mockResolvedValueOnce({
      success: true,
      stdout: skills,
      stderr: '',
    })

    await expect(createDeviceApi(client).listSkills('device-1')).resolves.toEqual([
      skills[3],
      skills[1],
      skills[0],
    ])

    expect(client.post).toHaveBeenCalledWith(
      '/devices/device-1/commands',
      expect.objectContaining({
        command_key: 'ls_skills',
      })
    )
  })

  test('loads local device skills from JSON command stdout', async () => {
    const client = mockClient()
    const skills = [
      {
        name: 'env-context',
        description: 'Environment facts',
        path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
        source: 'codex',
      },
    ]
    vi.mocked(client.post).mockResolvedValueOnce({
      success: true,
      stdout: JSON.stringify(skills),
      stderr: '',
    })

    await expect(createDeviceApi(client).listSkills('device-1')).resolves.toEqual(skills)
  })

  test('configures shared local skill directories through the device command API', async () => {
    const client = mockClient()
    const result = {
      success: true,
      status: 'configured',
      shared_path: '/Users/crystal/.agents/skills',
      shared_created: true,
      legacy_paths: ['/Users/crystal/.codex/skills', '/Users/crystal/.claude/skills'],
      moved_count: 2,
      moved: [],
      links: [],
    }
    vi.mocked(client.post).mockResolvedValueOnce({
      success: true,
      stdout: result,
      stderr: '',
    })

    await expect(createDeviceApi(client).setupSharedSkills('device-1')).resolves.toEqual(result)

    expect(client.post).toHaveBeenCalledWith(
      '/devices/device-1/commands',
      expect.objectContaining({
        command_key: 'setup_shared_skills',
      })
    )
  })
})
