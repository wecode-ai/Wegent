import { describe, expect, test, vi } from 'vitest'
import { createDeviceApi } from './devices'
import type { HttpClient } from './http'
import { createModelApi } from './models'
import { createPluginApi } from './plugins'
import { createProjectApi } from './projects'
import { createSystemSkillApi } from './systemSkills'

function mockClient(): HttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }
}

describe('REST adapters', () => {
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

  test('cancels a model subscriber without aborting a shared transport request', async () => {
    const client = mockClient()
    const response = { data: [] }
    let resolveModels!: (value: typeof response) => void
    vi.mocked(client.get).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveModels = resolve
        })
    )
    const api = createModelApi(client)
    const controller = new AbortController()
    const cancelled = api.listModels({ signal: controller.signal })
    const active = api.listModels()
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    controller.abort()
    await rejected
    expect(client.get).toHaveBeenCalledExactlyOnceWith(
      '/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework',
      { signal: expect.any(AbortSignal) }
    )
    expect(vi.mocked(client.get).mock.calls[0][1]?.signal?.aborted).toBe(false)
    resolveModels(response)
    await expect(active).resolves.toEqual(response)
    await expect(api.listModels()).resolves.toEqual(response)
    expect(client.get).toHaveBeenCalledOnce()
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

  test('ensures a built-in plugin without requiring a target device', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({ plugin: {} })

    await createPluginApi(client).ensureBuiltinPluginInstalled('wegent-sites')

    expect(client.post).toHaveBeenCalledWith('/plugins/builtin/wegent-sites/ensure-installed', {})
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
