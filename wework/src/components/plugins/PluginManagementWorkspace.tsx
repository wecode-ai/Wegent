import {
  ChevronRight,
  MoreHorizontal,
  Search,
} from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { createHttpClient } from '@/api/http'
import { createMcpApi } from '@/api/mcps'
import { createPluginApi } from '@/api/plugins'
import { createSystemSkillApi } from '@/api/systemSkills'
import { getRuntimeConfig } from '@/config/runtime'
import { navigateTo } from '@/lib/navigation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import {
  DESKTOP_TOP_BAR_BUTTON_CLASS,
  DesktopTopBar,
  MAC_NATIVE_TOP_BAR_ACTION_INSET,
} from '@/components/layout/DesktopTopBar'
import {
  CustomMcpDialog,
  McpProviderBlock,
  SectionHeading,
  type CustomMcpFormState,
} from './McpManagementSections'
import {
  serverConfigFromProviderServer,
  serverKeyFromProviderServer,
} from './mcp-utils'
import { parseOptionalStringRecordJson } from './mcp-json-import'
import {
  InstalledMcpRow,
  InstalledPluginRow,
  InstalledSkillRow,
  type InstalledMcpItem,
  type InstalledPluginItem,
  type InstalledSkillItem,
} from './PluginManagementRows'
import { PluginCreateMenu } from './PluginCreateMenu'
import { PluginDetailView } from './PluginDetailView'
import { PluginUploadDialog } from './PluginUploadDialog'
import { SkillUploadDialog } from './SkillUploadDialog'
import type {
  InstalledMCP,
  InstalledPlugin,
  InstalledMCPServerConfig,
  InstalledSkill,
  MCPProviderInfo,
  MCPServer,
} from '@/types/api'

type ManagementTab =
  | 'plugins'
  | 'apps'
  | 'mcp'
  | 'skills'
  | 'marketplace'

const tabs: Array<{
  id: ManagementTab
  labelKey: string
  fallback: string
}> = [
  {
    id: 'plugins',
    labelKey: 'plugin_management_tab_plugins',
    fallback: '插件',
  },
  {
    id: 'apps',
    labelKey: 'plugin_management_tab_apps',
    fallback: '应用',
  },
  {
    id: 'mcp',
    labelKey: 'plugin_management_tab_mcp',
    fallback: 'MCP',
  },
  {
    id: 'skills',
    labelKey: 'plugin_management_tab_skills',
    fallback: '技能',
  },
  {
    id: 'marketplace',
    labelKey: 'plugin_management_tab_marketplace',
    fallback: '市场',
  },
]

function tabClassName(selected: boolean) {
  return [
    'h-9 shrink-0 rounded-lg px-3 text-[15px] font-semibold leading-5 transition-colors',
    selected
      ? 'bg-[#f3f3f4] text-[#101014]'
      : 'text-[#85858c] hover:text-[#101014]',
  ].join(' ')
}

function emptyStateClassName() {
  return 'py-10 text-sm font-semibold text-text-secondary'
}

function createDefaultSystemSkillApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createSystemSkillApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function getInstalledSkillId(item: InstalledSkill): number {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object'
      ? (labels as Record<string, unknown>).id
      : undefined
  return Number(id ?? 0)
}

function toInstalledSkillItem(item: InstalledSkill): InstalledSkillItem {
  return {
    id: getInstalledSkillId(item),
    name: item.spec.displayName || item.spec.source.skillKey,
    description: item.spec.description,
    enabled: item.spec.enabled,
    sourceType: item.spec.source.type === 'personal' ? 'personal' : 'system',
  }
}

function getInstalledMcpId(item: InstalledMCP): number {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object'
      ? (labels as Record<string, unknown>).id
      : undefined
  return Number(id ?? 0)
}

function toInstalledMcpItem(item: InstalledMCP): InstalledMcpItem {
  return {
    id: getInstalledMcpId(item),
    name: item.spec.displayName || item.spec.source.serverKey,
    description: item.spec.description || item.spec.server.url || '',
    enabled: item.spec.enabled,
    serverType: item.spec.server.type,
  }
}

function toInstalledPluginItem(item: InstalledPlugin): InstalledPluginItem {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object'
      ? (labels as Record<string, unknown>).id
      : undefined
  const components = item.spec.components
  return {
    id: Number(id ?? 0),
    name: item.spec.displayName || item.spec.source.pluginKey,
    description: item.spec.description,
    enabled: item.spec.enabled,
    version: item.spec.version,
    componentCounts: {
      skills: components.skills.length,
      commands: components.commands.length,
      agents: components.agents.length,
      mcp: components.mcps.length,
      hooks: components.hooks.length,
      lsp: components.lsps.length,
      monitors: components.monitors.length,
      bin: components.bins.length,
    },
    raw: item,
  }
}

const emptyCustomMcpForm: CustomMcpFormState = {
  name: '',
  displayName: '',
  description: '',
  type: 'streamable-http',
  url: '',
  command: '',
  args: '',
  envJson: '',
  headersJson: '',
}

function serverConfigFromCustomForm(
  form: CustomMcpFormState,
): InstalledMCPServerConfig {
  if (form.type === 'stdio') {
    return {
      type: 'stdio',
      command: form.command.trim(),
      args: form.args
        .split(/\s+/)
        .map((arg) => arg.trim())
        .filter(Boolean),
      env: parseOptionalStringRecordJson(form.envJson) ?? undefined,
    }
  }

  return {
    type: form.type,
    url: form.url.trim(),
    base_url: form.url.trim(),
    headers: parseOptionalStringRecordJson(form.headersJson) ?? undefined,
  }
}

interface PluginManagementWorkspaceProps {
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
}

export function PluginManagementWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
}: PluginManagementWorkspaceProps) {
  const { t } = useTranslation('common')
  const reserveMacWindowControls = isTauriRuntime()
  const [activeTab, setActiveTab] = useState<ManagementTab>('plugins')
  const [query, setQuery] = useState('')
  const systemSkillApi = useMemo(() => createDefaultSystemSkillApi(), [])
  const pluginApi = useMemo(() => {
    const { apiBaseUrl } = getRuntimeConfig()
    return createPluginApi(createHttpClient({ baseUrl: apiBaseUrl }))
  }, [])
  const mcpApi = useMemo(() => {
    const { apiBaseUrl } = getRuntimeConfig()
    return createMcpApi(createHttpClient({ baseUrl: apiBaseUrl }))
  }, [])
  const [installedMcps, setInstalledMcps] = useState<InstalledMcpItem[]>([])
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginItem[]>(
    [],
  )
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillItem[]>(
    [],
  )
  const [mcpProviders, setMcpProviders] = useState<MCPProviderInfo[]>([])
  const [providerServers, setProviderServers] = useState<
    Record<string, MCPServer[]>
  >({})
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>(
    {},
  )
  const [providerLoadingByKey, setProviderLoadingByKey] = useState<
    Record<string, boolean>
  >({})
  const [providerSavingByKey, setProviderSavingByKey] = useState<
    Record<string, boolean>
  >({})
  const [providerTokenInputs, setProviderTokenInputs] = useState<
    Record<string, string>
  >({})
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false)
  const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false)
  const [showSkillUploadDialog, setShowSkillUploadDialog] = useState(false)
  const [showPluginUploadDialog, setShowPluginUploadDialog] = useState(false)
  const [selectedPluginId, setSelectedPluginId] = useState<number | null>(null)
  const [customMcpForm, setCustomMcpForm] =
    useState<CustomMcpFormState>(emptyCustomMcpForm)
  const [isCreatingCustomMcp, setIsCreatingCustomMcp] = useState(false)
  const [isUploadingSkill, setIsUploadingSkill] = useState(false)
  const [isUploadingPlugin, setIsUploadingPlugin] = useState(false)
  const [isLoadingMcps, setIsLoadingMcps] = useState(true)
  const [isLoadingPlugins, setIsLoadingPlugins] = useState(true)
  const [isLoadingSkills, setIsLoadingSkills] = useState(true)
  const normalizedQuery = query.trim().toLowerCase()

  useEffect(() => {
    let isCurrent = true

    systemSkillApi
      .listInstalledSystemSkills()
      .then((response) => {
        if (!isCurrent) return
        setInstalledSkills(response.items.map(toInstalledSkillItem))
      })
      .catch(() => {
        if (!isCurrent) return
        setInstalledSkills([])
      })
      .finally(() => {
        if (isCurrent) setIsLoadingSkills(false)
      })

    mcpApi
      .listInstalledMcps()
      .then((response) => {
        if (!isCurrent) return
        setInstalledMcps(response.items.map(toInstalledMcpItem))
        setIsLoadingMcps(false)
      })
      .catch(() => {
        if (!isCurrent) return
        setInstalledMcps([])
        setIsLoadingMcps(false)
      })

    pluginApi
      .listInstalledPlugins()
      .then((response) => {
        if (!isCurrent) return
        setInstalledPlugins(response.items.map(toInstalledPluginItem))
        setIsLoadingPlugins(false)
      })
      .catch(() => {
        if (!isCurrent) return
        setInstalledPlugins([])
        setIsLoadingPlugins(false)
      })

    mcpApi
      .listProviders()
      .then((response) => {
        if (!isCurrent) return
        setMcpProviders(response.providers)
      })
      .catch(() => {
        if (!isCurrent) return
        setMcpProviders([])
      })

    return () => {
      isCurrent = false
    }
  }, [mcpApi, pluginApi, systemSkillApi])

  const filteredInstalledSkills = useMemo(
    () =>
      installedSkills.filter((skill) => {
        if (!normalizedQuery) return true

        return (
          skill.name.toLowerCase().includes(normalizedQuery) ||
          skill.description.toLowerCase().includes(normalizedQuery)
        )
      }),
    [installedSkills, normalizedQuery],
  )

  const filteredInstalledMcps = useMemo(
    () =>
      installedMcps.filter((mcp) => {
        if (!normalizedQuery) return true

        return (
          mcp.name.toLowerCase().includes(normalizedQuery) ||
          mcp.description.toLowerCase().includes(normalizedQuery) ||
          mcp.serverType.toLowerCase().includes(normalizedQuery)
        )
      }),
    [installedMcps, normalizedQuery],
  )

  const filteredInstalledPlugins = useMemo(
    () =>
      installedPlugins.filter((plugin) => {
        if (!normalizedQuery) return true

        return (
          plugin.name.toLowerCase().includes(normalizedQuery) ||
          plugin.description.toLowerCase().includes(normalizedQuery) ||
          Object.keys(plugin.componentCounts).some((key) =>
            key.toLowerCase().includes(normalizedQuery),
          )
        )
      }),
    [installedPlugins, normalizedQuery],
  )
  const selectedPlugin = useMemo(
    () =>
      selectedPluginId === null
        ? null
        : installedPlugins.find((plugin) => plugin.id === selectedPluginId) ??
          null,
    [installedPlugins, selectedPluginId],
  )

  const filteredMcpProviders = useMemo(
    () =>
      mcpProviders.filter((provider) => {
        if (!normalizedQuery) return true

        return (
          provider.name.toLowerCase().includes(normalizedQuery) ||
          provider.description.toLowerCase().includes(normalizedQuery) ||
          provider.key.toLowerCase().includes(normalizedQuery)
        )
      }),
    [mcpProviders, normalizedQuery],
  )

  const toggleInstalledSkill = (id: number) => {
    const skill = installedSkills.find((item) => item.id === id)
    if (!skill) return

    setInstalledSkills((previous) =>
      previous.map((skill) =>
        skill.id === id ? { ...skill, enabled: !skill.enabled } : skill,
      ),
    )

    systemSkillApi.updateInstalledSystemSkill(id, !skill.enabled).catch(() => {
      setInstalledSkills((previous) =>
        previous.map((item) =>
          item.id === id ? { ...item, enabled: skill.enabled } : item,
        ),
      )
    })
  }

  const uninstallInstalledSkill = (id: number) => {
    const skill = installedSkills.find((item) => item.id === id)
    if (!skill) return

    setInstalledSkills((previous) => previous.filter((item) => item.id !== id))
    systemSkillApi
      .uninstallInstalledSystemSkill(id)
      .catch(() => setInstalledSkills((previous) => [...previous, skill]))
  }

  const toggleInstalledMcp = (id: number) => {
    setInstalledMcps((previous) =>
      previous.map((mcp) =>
        mcp.id === id ? { ...mcp, enabled: !mcp.enabled } : mcp,
      ),
    )
    const mcp = installedMcps.find((item) => item.id === id)
    if (!mcp) return

    mcpApi.updateInstalledMcp(id, { enabled: !mcp.enabled }).catch(() => {
      setInstalledMcps((previous) =>
        previous.map((item) =>
          item.id === id ? { ...item, enabled: mcp.enabled } : item,
        ),
      )
    })
  }

  const uninstallInstalledMcp = (id: number) => {
    const mcp = installedMcps.find((item) => item.id === id)
    if (!mcp) return

    setInstalledMcps((previous) => previous.filter((item) => item.id !== id))
    mcpApi.uninstallInstalledMcp(id).catch(() => {
      setInstalledMcps((previous) => [...previous, mcp])
    })
  }

  const toggleInstalledPlugin = (id: number) => {
    const plugin = installedPlugins.find((item) => item.id === id)
    if (!plugin) return

    setInstalledPlugins((previous) =>
      previous.map((item) =>
        item.id === id ? { ...item, enabled: !item.enabled } : item,
      ),
    )
    pluginApi.updateInstalledPlugin(id, { enabled: !plugin.enabled }).catch(() => {
      setInstalledPlugins((previous) =>
        previous.map((item) =>
          item.id === id ? { ...item, enabled: plugin.enabled } : item,
        ),
      )
    })
  }

  const togglePluginComponent = (
    id: number,
    componentKey: string,
    enabled: boolean,
  ) => {
    const plugin = installedPlugins.find((item) => item.id === id)
    if (!plugin) return

    const previousStates = plugin.raw.spec.componentStates || {}
    const nextStates = { ...previousStates, [componentKey]: enabled }
    setInstalledPlugins((previous) =>
      previous.map((item) =>
        item.id === id
          ? {
              ...item,
              raw: {
                ...item.raw,
                spec: {
                  ...item.raw.spec,
                  componentStates: nextStates,
                },
              },
            }
          : item,
      ),
    )
    pluginApi
      .updateInstalledPlugin(id, { componentStates: { [componentKey]: enabled } })
      .then((updated) => {
        const nextItem = toInstalledPluginItem(updated)
        setInstalledPlugins((previous) =>
          previous.map((item) => (item.id === id ? nextItem : item)),
        )
      })
      .catch(() => {
        setInstalledPlugins((previous) =>
          previous.map((item) => (item.id === id ? plugin : item)),
        )
      })
  }

  const uninstallInstalledPlugin = (id: number) => {
    const plugin = installedPlugins.find((item) => item.id === id)
    if (!plugin) return

    setInstalledPlugins((previous) => previous.filter((item) => item.id !== id))
    setSelectedPluginId((current) => (current === id ? null : current))
    pluginApi.uninstallInstalledPlugin(id).catch(() => {
      setInstalledPlugins((previous) => [...previous, plugin])
    })
  }

  const createCustomMcp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const displayName = customMcpForm.displayName.trim()
    const name = customMcpForm.name.trim()
    if (!name || !displayName) return

    setIsCreatingCustomMcp(true)
    mcpApi
      .createCustomMcp({
        name,
        displayName,
        description: customMcpForm.description.trim(),
        server: serverConfigFromCustomForm(customMcpForm),
        enabled: true,
      })
      .then((item) => {
        setInstalledMcps((previous) => [toInstalledMcpItem(item), ...previous])
        setCustomMcpForm(emptyCustomMcpForm)
        setShowCustomMcpDialog(false)
      })
      .finally(() => setIsCreatingCustomMcp(false))
  }

  const uploadPersonalSkill = async (file: File, name: string) => {
    setIsUploadingSkill(true)
    try {
      const uploaded = await systemSkillApi.uploadPersonalSkill(file, name)
      const labels = uploaded.metadata['labels']
      const skillId =
        labels && typeof labels === 'object'
          ? Number((labels as Record<string, unknown>).id)
          : 0
      if (!Number.isFinite(skillId) || skillId <= 0) {
        throw new Error('Uploaded skill is missing id')
      }
      const installed = await systemSkillApi.installPersonalSkill(skillId)
      const item = toInstalledSkillItem(installed)
      setInstalledSkills((previous) => [
        item,
        ...previous.filter((skill) => skill.id !== item.id),
      ])
      setActiveTab('skills')
      setShowSkillUploadDialog(false)
    } finally {
      setIsUploadingSkill(false)
    }
  }

  const uploadPlugin = async (file: File) => {
    setIsUploadingPlugin(true)
    try {
      const uploaded = await pluginApi.uploadPlugin(file)
      const item = toInstalledPluginItem(uploaded)
      setInstalledPlugins((previous) => [
        item,
        ...previous.filter((plugin) => plugin.id !== item.id),
      ])
      setActiveTab('plugins')
      setShowPluginUploadDialog(false)
    } finally {
      setIsUploadingPlugin(false)
    }
  }

  const loadProviderServers = (providerKey: string) => {
    setProviderLoadingByKey((previous) => ({ ...previous, [providerKey]: true }))
    setProviderErrors((previous) => ({ ...previous, [providerKey]: '' }))

    mcpApi
      .listProviderServers(providerKey)
      .then((response) => {
        if (!response.success) {
          setProviderErrors((previous) => ({
            ...previous,
            [providerKey]: response.message,
          }))
          setProviderServers((previous) => ({ ...previous, [providerKey]: [] }))
          return
        }
        setProviderServers((previous) => ({
          ...previous,
          [providerKey]: response.servers,
        }))
      })
      .catch((error: Error) => {
        setProviderErrors((previous) => ({
          ...previous,
          [providerKey]: error.message,
        }))
      })
      .finally(() => {
        setProviderLoadingByKey((previous) => ({
          ...previous,
          [providerKey]: false,
        }))
      })
  }

  const saveProviderToken = (provider: MCPProviderInfo) => {
    const value = providerTokenInputs[provider.key]?.trim()
    if (!value) return

    setProviderSavingByKey((previous) => ({ ...previous, [provider.key]: true }))
    mcpApi
      .updateProviderKeys({ [provider.token_field_name]: value })
      .then(() => {
        setMcpProviders((previous) =>
          previous.map((item) =>
            item.key === provider.key ? { ...item, has_token: true } : item,
          ),
        )
        setProviderTokenInputs((previous) => ({
          ...previous,
          [provider.key]: '',
        }))
        loadProviderServers(provider.key)
      })
      .finally(() => {
        setProviderSavingByKey((previous) => ({
          ...previous,
          [provider.key]: false,
        }))
      })
  }

  const installProviderServer = (provider: MCPProviderInfo, server: MCPServer) => {
    mcpApi
      .installProviderMcp({
        providerKey: provider.key,
        serverKey: serverKeyFromProviderServer(server),
        catalogItemId: server.id,
        displayName: server.name,
        description: server.description ?? '',
        server: serverConfigFromProviderServer(server),
        sourcePayload: server as unknown as Record<string, unknown>,
      })
      .then((item) => {
        const installed = toInstalledMcpItem(item)
        setInstalledMcps((previous) => [
          installed,
          ...previous.filter((mcp) => mcp.id !== installed.id),
        ])
        setProviderServers((previous) => ({
          ...previous,
          [provider.key]: (previous[provider.key] ?? []).map((candidate) =>
            candidate.id === server.id
              ? {
                  ...candidate,
                  installState: 'installed',
                  installedMcpId: installed.id,
                  enabled: installed.enabled,
                }
              : candidate,
          ),
        }))
      })
  }

  if (activeTab === 'plugins' && selectedPlugin) {
    return (
      <PluginDetailView
        plugin={selectedPlugin}
        onBack={() => setSelectedPluginId(null)}
        onToggle={() => toggleInstalledPlugin(selectedPlugin.id)}
        onComponentToggle={(componentKey, enabled) =>
          togglePluginComponent(selectedPlugin.id, componentKey, enabled)
        }
        onUninstall={() => uninstallInstalledPlugin(selectedPlugin.id)}
      />
    )
  }

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-white text-[#101014]">
      <DesktopTopBar
        testId="plugin-management-topbar"
        className={[
          'sticky top-0 z-30 h-12 bg-white/94 pl-20 pr-4 backdrop-blur-xl md:h-[52px] md:pr-7',
          sidebarCollapsed
            ? reserveMacWindowControls
              ? undefined
              : 'md:pl-6'
            : 'md:pl-7',
        ].join(' ')}
        style={
          sidebarCollapsed && reserveMacWindowControls
            ? { paddingLeft: MAC_NATIVE_TOP_BAR_ACTION_INSET }
            : undefined
        }
        left={(
          <>
            {topBarLeftActions}
            <nav
              className="flex items-center gap-3 text-sm font-semibold"
              aria-label="breadcrumb"
            >
              <button
                type="button"
                className="text-[#85858c] transition-colors hover:text-[#101014]"
                onClick={() => navigateTo('/plugins')}
              >
                {t('workbench.plugins_tab', '插件')}
              </button>
              <ChevronRight className="h-4 w-4 text-[#85858c]" />
              <span>{t('workbench.plugins_manage', '管理')}</span>
            </nav>
          </>
        )}
        right={(
          <>
            <PluginCreateMenu
              isOpen={isCreateMenuOpen}
              buttonTestId="plugin-management-create-button"
              onToggle={() => setIsCreateMenuOpen((previous) => !previous)}
              onCreateSkill={() => {
                setIsCreateMenuOpen(false)
                setShowSkillUploadDialog(true)
              }}
              onCreateMcp={() => {
                setIsCreateMenuOpen(false)
                setShowCustomMcpDialog(true)
              }}
              onCreatePlugin={() => {
                setIsCreateMenuOpen(false)
                setShowPluginUploadDialog(true)
              }}
            />
            <button
              type="button"
              aria-label={t('workbench.plugins_more_actions', '更多操作')}
              className={DESKTOP_TOP_BAR_BUTTON_CLASS}
            >
              <MoreHorizontal />
            </button>
          </>
        )}
      />

      <section className="mx-auto flex w-full max-w-[940px] flex-col gap-8 px-5 pb-12 pt-8 md:pt-16">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-8">
          <div
            className="scrollbar-none -mx-1 flex items-center gap-2 overflow-x-auto px-1"
            role="tablist"
          >
            {tabs.map((tab) => {
              const count =
                tab.id === 'plugins'
                  ? installedPlugins.length
                  : tab.id === 'mcp'
                    ? installedMcps.length
                    : tab.id === 'skills'
                      ? installedSkills.length
                      : tab.id === 'marketplace'
                        ? mcpProviders.length
                        : 1
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={tabClassName(activeTab === tab.id)}
                  onClick={() => {
                    setSelectedPluginId(null)
                    setActiveTab(tab.id)
                  }}
                >
                  {t(`workbench.${tab.labelKey}`, tab.fallback)}{' '}
                  <span className="text-[#85858c]">{count}</span>
                </button>
              )
            })}
          </div>

          <label className="relative w-full shrink-0 md:w-[340px]">
            <span className="sr-only">
              {t('workbench.plugins_search_plugins', '搜索插件')}
            </span>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#85858c]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workbench.plugins_search_plugins', '搜索插件')}
              data-testid="plugin-management-search-input"
              className="h-10 w-full rounded-xl border border-[#dedee4] bg-white pl-11 pr-4 text-sm outline-none placeholder:text-[#85858c] focus:border-[#9da2ae]"
            />
          </label>
        </div>

        {activeTab === 'plugins' ? (
          <div className="space-y-9">
            {isLoadingPlugins ? (
              <div className={emptyStateClassName()}>
                {t('workbench.plugins_loading_plugins', '正在加载插件')}
              </div>
            ) : filteredInstalledPlugins.length > 0 ? (
              filteredInstalledPlugins.map((plugin) => (
                <InstalledPluginRow
                  key={plugin.id}
                  plugin={plugin}
                  onOpen={() => setSelectedPluginId(plugin.id)}
                  onToggle={() => toggleInstalledPlugin(plugin.id)}
                  onUninstall={() => uninstallInstalledPlugin(plugin.id)}
                />
              ))
            ) : (
              <div className="flex flex-col items-start gap-3 text-sm font-semibold text-text-secondary">
                <div>
                  {t('workbench.plugins_no_installed_plugins', '暂无已安装插件')}
                </div>
                <button
                  type="button"
                  data-testid="plugin-management-upload-plugin-button"
                  className="rounded-xl bg-primary px-4 py-2 text-white hover:bg-primary/90"
                  onClick={() => setShowPluginUploadDialog(true)}
                >
                  {t(
                    'workbench.plugins_plugin_upload_title',
                    '上传 Claude Code 插件',
                  )}
                </button>
              </div>
            )}
          </div>
        ) : activeTab === 'apps' ? (
          <div className={emptyStateClassName()}>
            {t('workbench.plugin_management_tab_apps', '应用')}
          </div>
        ) : activeTab === 'mcp' ? (
          <div className="space-y-9">
            <section className="space-y-5">
              <SectionHeading
                title={t('workbench.plugins_installed_mcps', '已安装 MCP')}
                description={t(
                  'workbench.plugins_installed_mcps_description',
                  '全局安装后会进入设备安装清单，可单独启用或卸载。',
                )}
              />
              {isLoadingMcps ? (
                <div className={emptyStateClassName()}>
                  {t('workbench.plugins_loading_mcps', '正在加载 MCP')}
                </div>
              ) : filteredInstalledMcps.length > 0 ? (
                filteredInstalledMcps.map((mcp) => (
                  <InstalledMcpRow
                    key={mcp.id}
                    mcp={mcp}
                    onToggle={() => toggleInstalledMcp(mcp.id)}
                    onUninstall={() => uninstallInstalledMcp(mcp.id)}
                  />
                ))
              ) : (
                <div className={emptyStateClassName()}>
                  {t('workbench.plugins_no_installed_mcps', '暂无已安装 MCP')}
                </div>
              )}
            </section>
          </div>
        ) : activeTab === 'skills' ? (
          <div className="space-y-9">
            {isLoadingSkills ? (
              <div className={emptyStateClassName()}>
                {t('workbench.plugins_loading_skills', '正在加载技能')}
              </div>
            ) : filteredInstalledSkills.length > 0 ? (
              filteredInstalledSkills.map((skill) => (
                <InstalledSkillRow
                  key={skill.id}
                  skill={skill}
                  onToggle={() => toggleInstalledSkill(skill.id)}
                  onUninstall={() => uninstallInstalledSkill(skill.id)}
                />
              ))
            ) : (
              <div className={emptyStateClassName()}>
                {t('workbench.plugins_no_mcp_results', '找不到匹配的 MCP')}
              </div>
            )}
          </div>
        ) : (
          <section className="space-y-5">
            <SectionHeading
              title={t('workbench.plugins_mcp_providers', 'MCP 供应商')}
              description={t(
                'workbench.plugins_mcp_providers_description',
                '配置 token 后同步供应商服务，并按供应商分区安装需要的 MCP。',
              )}
            />
            {filteredMcpProviders.length > 0 ? (
              filteredMcpProviders.map((provider) => (
                <McpProviderBlock
                  key={provider.key}
                  provider={provider}
                  servers={providerServers[provider.key] ?? []}
                  error={providerErrors[provider.key]}
                  tokenInput={providerTokenInputs[provider.key] ?? ''}
                  isLoading={providerLoadingByKey[provider.key] ?? false}
                  isSaving={providerSavingByKey[provider.key] ?? false}
                  onTokenChange={(value) =>
                    setProviderTokenInputs((previous) => ({
                      ...previous,
                      [provider.key]: value,
                    }))
                  }
                  onSaveToken={() => saveProviderToken(provider)}
                  onSync={() => loadProviderServers(provider.key)}
                  onInstall={(server) => installProviderServer(provider, server)}
                />
              ))
            ) : (
              <div className={emptyStateClassName()}>
                {t('workbench.plugins_no_search_results', '找不到匹配的技能')}
              </div>
            )}
          </section>
        )}
      </section>
      {showCustomMcpDialog && (
        <CustomMcpDialog
          form={customMcpForm}
          isSubmitting={isCreatingCustomMcp}
          onCancel={() => setShowCustomMcpDialog(false)}
          onChange={(nextForm) => setCustomMcpForm(nextForm)}
          onSubmit={createCustomMcp}
        />
      )}
      {showSkillUploadDialog && (
        <SkillUploadDialog
          isUploading={isUploadingSkill}
          onCancel={() => setShowSkillUploadDialog(false)}
          onUpload={uploadPersonalSkill}
        />
      )}
      {showPluginUploadDialog && (
        <PluginUploadDialog
          isUploading={isUploadingPlugin}
          onCancel={() => setShowPluginUploadDialog(false)}
          onUpload={uploadPlugin}
        />
      )}
    </main>
  )
}
