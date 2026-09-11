import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import * as api from '@/api/local/capabilities'
import { CapabilityWorkspace } from './CapabilityWorkspace'
import { SkillInstallDialog } from './SkillInstallDialog'
import { McpServerDialog } from './McpServerDialog'
import { McpPanel } from './McpPanel'
vi.mock('@/api/local/capabilities', async original => ({
  ...(await original<typeof api>()),
  listStandaloneSkills: vi.fn(),
  readCapabilityHome: vi.fn(),
  listMcpServers: vi.fn(),
  getCachedMcpServers: vi.fn(),
  previewSkills: vi.fn(),
  installSkills: vi.fn(),
  discardSkillPreview: vi.fn(),
  saveMcpServer: vi.fn(),
  reloadMcpServers: vi.fn(),
}))
vi.mock('@/components/layout/MacOSTitleBarDragRegion', () => ({
  MacOSTitleBarDragRegion: () => null,
}))
beforeEach(() => {
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  vi.mocked(api.listStandaloneSkills).mockResolvedValue({ skills: [], errors: [] })
  vi.mocked(api.readCapabilityHome).mockResolvedValue('/isolated/codex')
  vi.mocked(api.getCachedMcpServers).mockReturnValue(null)
  vi.mocked(api.listMcpServers).mockResolvedValue({ entries: [], statusError: false })
  vi.mocked(api.discardSkillPreview).mockResolvedValue({})
})
describe('Plugins capability workspace', () => {
  test('shows saved MCP configuration even when runtime reload fails', async () => {
    vi.mocked(api.reloadMcpServers).mockRejectedValueOnce(new Error('Runtime unavailable'))
    render(<McpPanel />)
    await waitFor(() => expect(screen.getByTestId('mcp-refresh')).not.toBeDisabled())
    vi.mocked(api.listMcpServers).mockResolvedValueOnce({
      entries: [{ name: 'saved-server', config: { command: 'node', enabled: false } }],
      statusError: false,
    })
    fireEvent.click(screen.getByTestId('mcp-refresh'))
    expect(await screen.findByText('saved-server')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
  test('renders expanded MCP tools as scannable definition rows', async () => {
    vi.mocked(api.listMcpServers).mockResolvedValueOnce({
      entries: [
        {
          name: 'codex_apps',
          config: null,
          status: {
            name: 'codex_apps',
            serverInfo: { name: 'codex_apps' },
            authStatus: 'unsupported',
            tools: {
              github_add_issue: {
                name: 'github.add_issue_assignees',
                description: 'Add assignees to an issue or pull request.',
              },
            },
          },
        },
      ],
      statusError: false,
    })
    render(<McpPanel />)
    const toolsButton = await screen.findByTestId('mcp-tools-0')
    expect(screen.queryByTestId('mcp-tool-0-0')).not.toBeInTheDocument()
    fireEvent.click(toolsButton)
    expect(screen.getByTestId('mcp-tool-0-0')).toHaveTextContent('github.add_issue_assignees')
    expect(screen.getByTestId('mcp-tool-0-0')).toHaveTextContent('Add assignees')
    fireEvent.click(toolsButton)
    expect(screen.queryByTestId('mcp-tool-0-0')).not.toBeInTheDocument()
  })
  test('paints cached MCP inventory before the background refresh finishes', async () => {
    let resolveRefresh: (result: api.McpListResult) => void = () => undefined
    vi.mocked(api.getCachedMcpServers).mockReturnValue({
      entries: [{ name: 'cached-server', config: { command: 'node' } }],
      statusError: false,
    })
    vi.mocked(api.listMcpServers).mockReturnValue(
      new Promise(resolve => {
        resolveRefresh = resolve
      })
    )
    const view = render(<McpPanel />)
    expect(screen.getByText('cached-server')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-add')).not.toBeDisabled()
    resolveRefresh({ entries: [], statusError: false })
    view.unmount()
  })
  test('switches between existing plugins, Skills and MCP without loading unused panels', async () => {
    render(
      <CapabilityWorkspace showPluginDetail={false}>
        <div>Existing marketplace</div>
      </CapabilityWorkspace>
    )
    expect(api.listStandaloneSkills).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('capability-tab-skills'))
    await waitFor(() => expect(api.listStandaloneSkills).toHaveBeenCalled())
    expect(screen.getByTestId('skills-panel')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('capability-tab-skills'), { key: 'ArrowRight' })
    await waitFor(() => expect(api.listMcpServers).toHaveBeenCalled())
    expect(screen.getByTestId('capability-tab-mcp')).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByTestId('capability-tab-plugins'))
    expect(screen.getByText('Existing marketplace')).toBeInTheDocument()
  })
  test('previews before installation and leaves conflicts visible for recovery', async () => {
    const onInstalled = vi.fn()
    vi.mocked(api.previewSkills).mockResolvedValue({
      token: 'preview',
      skills: [
        { name: 'weekly-report', path: 'skills/weekly-report', description: 'Weekly summary' },
      ],
    })
    vi.mocked(api.installSkills).mockRejectedValueOnce(new Error('Skill already exists'))
    render(
      <SkillInstallDialog kind="git" projectPath="" onClose={vi.fn()} onInstalled={onInstalled} />
    )
    fireEvent.change(screen.getByTestId('skill-source'), {
      target: { value: 'git@git.example.test:company/skills.git' },
    })
    fireEvent.click(screen.getByTestId('skill-install-submit'))
    await screen.findByTestId('skill-candidate-0')
    expect(api.installSkills).not.toHaveBeenCalled()
    expect(screen.getByTestId('skill-install-submit')).toBeDisabled()
    fireEvent.click(screen.getByTestId('skill-candidate-0'))
    fireEvent.click(screen.getByTestId('skill-install-submit'))
    await screen.findByRole('alert')
    expect(api.installSkills).toHaveBeenCalledWith('preview', ['skills/weekly-report'], undefined)
    expect(onInstalled).not.toHaveBeenCalled()
    expect(screen.queryByTestId('skill-source')).not.toBeInTheDocument()
  })
  test('validates MCP config and preserves existing unrelated options', async () => {
    const onSaved = vi.fn()
    render(
      <McpServerDialog
        names={['company']}
        entry={{
          name: 'company',
          config: {
            url: 'https://example.test/mcp',
            enabled: false,
            startup_timeout_sec: 25,
            env_http_headers: { 'X-Team': 'TEAM' },
          },
        }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    )
    fireEvent.change(screen.getByTestId('mcp-url'), { target: { value: 'file:///tmp/service' } })
    fireEvent.click(screen.getByTestId('mcp-save'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(api.saveMcpServer).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('mcp-url'), {
      target: { value: 'https://example.test/new-mcp' },
    })
    fireEvent.click(screen.getByTestId('mcp-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(api.saveMcpServer).toHaveBeenCalledWith('company', {
      url: 'https://example.test/new-mcp',
      enabled: false,
      startup_timeout_sec: 25,
      env_http_headers: { 'X-Team': 'TEAM' },
    })
  })
})
