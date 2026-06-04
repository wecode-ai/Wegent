import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { PluginsWorkspace } from './PluginsWorkspace'

async function openSkillsTab() {
  await userEvent.click(screen.getByRole('tab', { name: '技能' }))
}

function createSkillZipFile(name: string, rootSkillMd = false): File {
  const encoder = new TextEncoder()
  const fileName = rootSkillMd ? 'SKILL.md' : `${name}/SKILL.md`
  const fileNameBytes = encoder.encode(fileName)
  const contentBytes = encoder.encode(
    [
      '---',
      `name: ${name}`,
      'description: Uploaded helper',
      'version: 1.0.0',
      'author: Alice',
      'tags: [personal, upload]',
      '---',
      '',
      'Use this skill carefully.',
    ].join('\n'),
  )
  const localHeader = new Uint8Array(30 + fileNameBytes.length)
  const localView = new DataView(localHeader.buffer)
  localView.setUint32(0, 0x04034b50, true)
  localView.setUint16(4, 20, true)
  localView.setUint16(8, 0, true)
  localView.setUint32(18, contentBytes.length, true)
  localView.setUint32(22, contentBytes.length, true)
  localView.setUint16(26, fileNameBytes.length, true)
  localHeader.set(fileNameBytes, 30)

  const centralHeader = new Uint8Array(46 + fileNameBytes.length)
  const centralView = new DataView(centralHeader.buffer)
  centralView.setUint32(0, 0x02014b50, true)
  centralView.setUint16(4, 20, true)
  centralView.setUint16(6, 20, true)
  centralView.setUint16(10, 0, true)
  centralView.setUint32(20, contentBytes.length, true)
  centralView.setUint32(24, contentBytes.length, true)
  centralView.setUint16(28, fileNameBytes.length, true)
  centralHeader.set(fileNameBytes, 46)

  const centralDirectoryOffset = localHeader.length + contentBytes.length
  const endHeader = new Uint8Array(22)
  const endView = new DataView(endHeader.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, 1, true)
  endView.setUint16(10, 1, true)
  endView.setUint32(12, centralHeader.length, true)
  endView.setUint32(16, centralDirectoryOffset, true)

  return new File(
    [localHeader, contentBytes, centralHeader, endHeader],
    `${name}.zip`,
    {
      type: 'application/zip',
    },
  )
}

function mockSystemSkillsFetch(
  overrides: Partial<{
    installState: 'not_installed' | 'installed' | 'update_available'
    enabled: boolean
    installedSkillId: number | null
  }> = {},
) {
  const personalSkillsResponse = {
    items: [
      {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Skill',
        metadata: {
          name: 'excel-helper',
          namespace: 'default',
          labels: { id: '77' },
        },
        spec: {
          description: 'Analyze Excel workbooks',
          displayName: 'Excel Helper',
          version: '1.0.0',
          author: 'Alice',
          tags: ['personal'],
          prompt: 'Use spreadsheets carefully',
        },
      },
    ],
  }
  const uploadedPersonalSkill = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'Skill',
    metadata: {
      name: 'zip-helper',
      namespace: 'default',
      labels: { id: '78' },
    },
    spec: {
      description: 'Uploaded helper',
      displayName: 'zip-helper',
      version: '1.0.0',
      author: 'Alice',
      tags: ['personal'],
      prompt: 'Uploaded prompt',
    },
  }
  const installedPersonalSkill = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledSkill',
    metadata: {
      name: 'personal-excel-helper',
      namespace: 'default',
      labels: { id: '88' },
    },
    spec: {
      source: {
        type: 'personal',
        skillKey: 'excel-helper',
        catalogItemId: 'personal/77',
      },
      skillRef: {
        kind: 'Skill',
        name: 'excel-helper',
        namespace: 'default',
        user_id: 1,
      },
      displayName: 'Excel Helper',
      description: 'Analyze Excel workbooks',
      version: '1.0.0',
      installState: 'installed',
      enabled: true,
      sourcePayload: null,
    },
    status: { state: 'Available' },
  }
  const installedUploadedPersonalSkill = {
    ...installedPersonalSkill,
    metadata: {
      name: 'personal-zip-helper',
      namespace: 'default',
      labels: { id: '89' },
    },
    spec: {
      ...installedPersonalSkill.spec,
      source: {
        type: 'personal',
        skillKey: 'zip-helper',
        catalogItemId: 'personal/78',
      },
      skillRef: {
        kind: 'Skill',
        name: 'zip-helper',
        namespace: 'default',
        user_id: 1,
      },
      displayName: 'zip-helper',
      description: 'Uploaded helper',
    },
  }
  const mcpProvidersResponse = {
    providers: [
      {
        key: 'mcp_router',
        name: 'MCP Router',
        name_en: 'MCP Router',
        description: 'MCP Router provider',
        discover_url: 'https://example.com/mcp',
        api_key_url: 'https://example.com/token',
        token_field_name: 'mcp_router',
        requires_token: true,
        has_token: true,
      },
    ],
  }
  const mcpProviderServersResponse = {
    success: true,
    message: 'ok',
    servers: [
      {
        id: '@mcp_router/hot-search',
        name: 'Hot Search MCP',
        description: 'Read hot search data',
        type: 'streamable-http',
        base_url: 'https://mcp.example.com/hot-search',
        command: null,
        args: null,
        env: null,
        headers: null,
        is_active: true,
        provider: 'MCP Router',
        provider_url: null,
        logo_url: null,
        tags: ['search'],
        installState: 'not_installed',
        installedMcpId: null,
        enabled: false,
      },
    ],
  }
  const installedProviderMcp = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledMCP',
    metadata: {
      name: 'hot-search',
      namespace: 'default',
      labels: { id: '9' },
    },
    spec: {
      source: {
        type: 'provider',
        providerKey: 'mcp_router',
        serverKey: 'hot-search',
        catalogItemId: '@mcp_router/hot-search',
      },
      displayName: 'Hot Search MCP',
      description: 'Read hot search data',
      server: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/hot-search',
      },
      installState: 'installed',
      enabled: true,
      sourcePayload: null,
    },
    status: { state: 'Available' },
  }
  const customMcpResponse = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledMCP',
    metadata: {
      name: 'local-docs',
      namespace: 'default',
      labels: { id: '10' },
    },
    spec: {
      source: {
        type: 'custom',
        serverKey: 'local-docs',
      },
      displayName: 'Local Docs',
      description: 'Local docs search',
      server: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/local',
      },
      installState: 'installed',
      enabled: true,
      sourcePayload: null,
    },
    status: { state: 'Available' },
  }
  const skill = (page: number) => ({
    id: `@weibo/page-${page}`,
    providerKey: 'weibo',
    providerName: 'Weibo Skill Market',
    name: `page-${page}`,
    displayName: `Weibo Skill ${page}`,
    description: `Skill page ${page}`,
    iconUrl: null,
    tags: ['system'],
    version: '1.0.0',
    author: 'Weibo',
    category: 'system',
    capabilities: [],
    detailUrl: null,
    installState: overrides.installState ?? 'not_installed',
    installedSkillId: overrides.installedSkillId,
    enabled: overrides.enabled ?? false,
    requiresPermission: false,
    permissionUrl: null,
    updatedAt: null,
  })

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const requestUrl = new URL(url, 'http://localhost')
      if (requestUrl.pathname === '/api/v1/kinds/skills/upload') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(uploadedPersonalSkill),
        })
      }
      if (requestUrl.pathname === '/api/v1/kinds/skills') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(personalSkillsResponse),
        })
      }
      if (requestUrl.pathname === '/api/system-skills/installed') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: [] }),
        })
      }
      if (requestUrl.pathname === '/api/system-skills/install/personal') {
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve(
              body.skillId === 78
                ? installedUploadedPersonalSkill
                : installedPersonalSkill,
            ),
        })
      }
      if (requestUrl.pathname === '/api/v1/kinds/skills/77') {
        return Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve(null),
        })
      }
      if (requestUrl.pathname === '/api/mcp-providers') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mcpProvidersResponse),
        })
      }
      if (requestUrl.pathname === '/api/mcp-providers/mcp_router/servers') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mcpProviderServersResponse),
        })
      }
      if (requestUrl.pathname === '/api/mcps/install') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(installedProviderMcp),
        })
      }
      if (requestUrl.pathname === '/api/mcps/custom') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(customMcpResponse),
        })
      }
      const page = Number(requestUrl.searchParams.get('page') ?? 1)
      const keyword = requestUrl.searchParams.get('keyword')
      const item = skill(page)
      const payload =
        init?.method === 'POST'
          ? {
              apiVersion: 'agent.wecode.io/v1',
              kind: 'InstalledSkill',
              metadata: {
                name: 'weibo-page-1',
                namespace: 'default',
                labels: { id: '42' },
              },
              spec: {
                source: {
                  type: 'system',
                  providerKey: item.providerKey,
                  skillKey: item.name,
                  catalogItemId: item.id,
                },
                skillRef: null,
                displayName: item.displayName,
                description: item.description,
                version: item.version,
                installState: 'installed',
                enabled: true,
                sourcePayload: null,
              },
              status: { state: 'Available' },
            }
          : {
              total: keyword ? 0 : 40,
              page,
              pageSize: 20,
              items: keyword ? [] : [item],
              providerErrors: [],
            }

      return Promise.resolve({
        ok: true,
        status: init?.method === 'DELETE' ? 204 : 200,
        json: () => Promise.resolve(payload),
      })
    }),
  )
}

describe('PluginsWorkspace', () => {
  beforeEach(() => {
    mockSystemSkillsFetch()
  })

  test('uses readable theme tokens for the selected catalog tab', async () => {
    render(<PluginsWorkspace />)

    await openSkillsTab()
    const skillsTab = screen.getByRole('tab', { name: '技能' })

    expect(skillsTab).toHaveAttribute('aria-selected', 'true')
    expect(skillsTab).toHaveClass(
      'bg-background',
      'text-text-primary',
    )
    expect(await screen.findByText('Weibo Skill 1')).toBeInTheDocument()
  })

  test('filters skills and shows the empty state for unmatched search', async () => {
    render(<PluginsWorkspace />)

    await openSkillsTab()
    expect(await screen.findByText('Weibo Skill 1')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-search-input')).toHaveClass(
      'h-11',
      'w-full',
    )

    await userEvent.type(
      screen.getByTestId('plugins-search-input'),
      'does-not-exist',
    )

    expect(await screen.findByText('找不到匹配的技能')).toBeInTheDocument()
    expect(screen.queryByText('Weibo Skill 1')).not.toBeInTheDocument()
  })

  test('uses a readable single-column mobile catalog layout', async () => {
    render(<PluginsWorkspace />)

    await openSkillsTab()
    expect(await screen.findByText('Weibo Skill 1')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-workspace')).toHaveClass(
      'bg-background',
      'text-text-primary',
    )
    expect(screen.getByRole('tablist')).toHaveClass('w-full', 'md:w-fit')
    expect(screen.getByRole('tab', { name: '技能' })).toHaveClass(
      'h-7',
      'flex-1',
      'bg-background',
      'text-text-primary',
    )
    expect(screen.getByTestId('plugins-search-input')).toHaveClass(
      'text-[13px]',
      'leading-[18px]',
    )
    expect(screen.getByTestId('plugins-mobile-section-filter')).toHaveClass(
      'md:hidden',
    )
    expect(screen.getByTestId('plugins-section-filter')).toHaveClass(
      'hidden',
      'md:block',
    )

    const catalogCard = screen.getByText('Weibo Skill 1').closest('article')
    expect(catalogCard).toHaveClass('grid', 'min-h-[72px]', 'border-b')
    expect(catalogCard?.querySelector('button')).toHaveClass(
      'h-11',
      'w-11',
    )

    const catalogGrid = screen
      .getByText('Weibo Skill 1')
      .closest('section')
      ?.querySelector('.grid')
    expect(catalogGrid).toHaveClass('grid-cols-1', 'sm:grid-cols-2')
  })

  test('shows personal skills and uploads a personal skill zip', async () => {
    render(<PluginsWorkspace />)

    await openSkillsTab()
    expect(await screen.findByText('Excel Helper')).toBeInTheDocument()

    await userEvent.selectOptions(
      screen.getByTestId('plugins-section-filter'),
      'personal',
    )
    expect(screen.getByText('Excel Helper')).toBeInTheDocument()
    expect(screen.queryByText('Weibo Skill 1')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('system-skills-pagination'),
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    expect(screen.getByTestId('plugins-create-menu')).toHaveClass(
      'bg-[rgb(var(--color-popover))]',
      'text-text-primary',
      'isolate',
    )
    expect(
      screen.getByTestId('plugins-create-skill-option'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('plugins-create-skill-option')).toHaveClass(
      'text-text-primary',
    )
    expect(screen.getByTestId('plugins-create-mcp-option')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-create-mcp-option')).toHaveClass(
      'text-text-primary',
    )
    await userEvent.click(screen.getByTestId('plugins-create-skill-option'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    const upload = screen.getByTestId('skill-upload-file-input')
    const file = createSkillZipFile('zip-helper', true)
    await userEvent.upload(upload, file)

    expect(await screen.findByDisplayValue('zip-helper')).toBeInTheDocument()
    expect(screen.getByText('Uploaded helper')).toBeInTheDocument()
    expect(screen.getByText('1.0.0')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('skill-upload-confirm-button'))

    expect(await screen.findByText('zip-helper')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/kinds/skills/upload',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
      }),
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/install/personal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ skillId: 78 }),
      }),
    )
  })

  test('opens the create menu and creates a custom MCP', async () => {
    render(<PluginsWorkspace />)

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    await userEvent.click(screen.getByTestId('plugins-create-mcp-option'))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('custom-mcp-import-json-button'))
    fireEvent.change(screen.getByTestId('custom-mcp-import-json-textarea'), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            'local-docs': {
              type: 'streamable-http',
              url: 'https://mcp.example.com/local',
              headers: { Authorization: 'Bearer token' },
              description: 'Local docs search',
            },
          },
        }),
      },
    })
    await userEvent.click(screen.getByTestId('custom-mcp-apply-json-button'))

    expect(screen.getByTestId('custom-mcp-name-input')).toHaveValue(
      'local-docs',
    )
    expect(screen.getByTestId('custom-mcp-display-name-input')).toHaveValue(
      'local-docs',
    )
    expect(screen.getByTestId('custom-mcp-url-input')).toHaveValue(
      'https://mcp.example.com/local',
    )
    expect(screen.getByTestId('custom-mcp-headers-input')).toHaveValue(
      '{\n  "Authorization": "Bearer token"\n}',
    )
    await userEvent.click(screen.getByTestId('custom-mcp-submit-button'))

    expect(fetch).toHaveBeenCalledWith(
      '/api/mcps/custom',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'local-docs',
          displayName: 'local-docs',
          description: 'Local docs search',
          server: {
            type: 'streamable-http',
            url: 'https://mcp.example.com/local',
            base_url: 'https://mcp.example.com/local',
            headers: { Authorization: 'Bearer token' },
          },
          enabled: true,
        }),
      }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('closes the create menu on outside click and Escape', async () => {
    render(<PluginsWorkspace />)

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    expect(screen.getByTestId('plugins-create-menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('plugins-create-menu')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugins-create-button'))
    expect(screen.getByTestId('plugins-create-menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('plugins-create-menu')).not.toBeInTheDocument()
  })

  test('places system pagination before the personal skills section', async () => {
    render(<PluginsWorkspace />)

    await openSkillsTab()
    expect(await screen.findByText('Weibo Skill 1')).toBeInTheDocument()
    expect(await screen.findByText('Excel Helper')).toBeInTheDocument()

    const systemHeading = screen.getByRole('heading', { name: '系统' })
    const pagination = screen.getByTestId('system-skills-pagination')
    const personalHeading = screen.getByRole('heading', { name: '个人' })

    expect(
      systemHeading.compareDocumentPosition(pagination) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      pagination.compareDocumentPosition(personalHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  test('shows configured MCP provider market data and installs a server', async () => {
    render(<PluginsWorkspace />)

    await userEvent.click(screen.getByRole('tab', { name: 'MCP' }))

    expect(await screen.findByText('MCP Router')).toBeInTheDocument()
    expect(await screen.findByText('Hot Search MCP')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/mcp-providers/mcp_router/servers',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) =>
          String(url).includes('/api/mcps/installed'),
        ),
    ).toBe(false)

    await userEvent.click(
      screen.getByTestId('mcp-market-install--mcp_router-hot-search'),
    )

    expect(
      await screen.findByTestId('mcp-market-uninstall--mcp_router-hot-search'),
    ).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/mcps/install',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"providerKey":"mcp_router"'),
      }),
    )

    await userEvent.click(
      screen.getByTestId('mcp-market-uninstall--mcp_router-hot-search'),
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.click(
      screen.getByTestId('mcp-market-confirm-uninstall-button'),
    )

    expect(fetch).toHaveBeenCalledWith(
      '/api/mcps/installed/9',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(
      await screen.findByTestId('mcp-market-install--mcp_router-hot-search'),
    ).toBeInTheDocument()
  })

  test('loads the next system skill page from the backend', async () => {
    render(<PluginsWorkspace />)

    await openSkillsTab()
    expect(await screen.findByText('Weibo Skill 1')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('system-skills-next-page-button'))

    expect(await screen.findByText('Weibo Skill 2')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills?category=system&page=2&pageSize=20',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  test('installs a system skill from the marketplace', async () => {
    render(<PluginsWorkspace />)

    await openSkillsTab()
    expect(await screen.findByText('Weibo Skill 1')).toBeInTheDocument()

    await userEvent.click(
      screen.getByTestId('system-skill-install--weibo-page-1'),
    )

    expect(
      await screen.findByTestId('system-skill-uninstall--weibo-page-1'),
    ).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/install',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"catalogItemId":"@weibo/page-1"'),
      }),
    )
  })

  test('shows personal skills as uninstalled until explicitly installed', async () => {
    render(<PluginsWorkspace />)

    await openSkillsTab()
    expect(await screen.findByText('Excel Helper')).toBeInTheDocument()
    expect(
      screen.getByTestId('system-skill-install-personal-excel-helper'),
    ).toBeInTheDocument()

    await userEvent.click(
      screen.getByTestId('system-skill-install-personal-excel-helper'),
    )

    expect(
      await screen.findByTestId('system-skill-uninstall-personal-excel-helper'),
    ).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/install/personal',
      expect.objectContaining({
        method: 'POST',
        body: '{"skillId":77}',
      }),
    )
  })

  test('uses icon actions for install and confirmed uninstall', async () => {
    mockSystemSkillsFetch({
      installState: 'installed',
      enabled: true,
      installedSkillId: 42,
    })

    render(<PluginsWorkspace />)

    await openSkillsTab()
    expect(await screen.findByText('Weibo Skill 1')).toBeInTheDocument()
    expect(
      screen.queryByTestId('system-skill-install--weibo-page-1'),
    ).not.toBeInTheDocument()

    await userEvent.click(
      screen.getByTestId('system-skill-uninstall--weibo-page-1'),
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.click(
      screen.getByTestId('system-skill-confirm-uninstall-button'),
    )

    expect(
      await screen.findByTestId('system-skill-install--weibo-page-1'),
    ).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/installed/42',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  test('shows an icon update action when a system skill has updates', async () => {
    mockSystemSkillsFetch({
      installState: 'update_available',
      enabled: true,
      installedSkillId: 42,
    })

    render(<PluginsWorkspace />)

    await openSkillsTab()
    expect(await screen.findByText('Weibo Skill 1')).toBeInTheDocument()

    await userEvent.click(
      screen.getByTestId('system-skill-update--weibo-page-1'),
    )

    expect(fetch).toHaveBeenCalledWith(
      '/api/system-skills/install',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"catalogItemId":"@weibo/page-1"'),
      }),
    )
  })
})
