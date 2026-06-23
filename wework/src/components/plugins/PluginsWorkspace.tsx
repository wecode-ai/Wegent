import {
  Boxes,
  BookOpen,
  Check,
  ImageIcon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { DESKTOP_TOP_BAR_BUTTON_CLASS, DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { useIsMobile } from '@/hooks/useIsMobile'
import { createHttpClient } from '@/api/http'
import { createMcpApi } from '@/api/mcps'
import { createPluginApi } from '@/api/plugins'
import { createSystemSkillApi } from '@/api/systemSkills'
import { getRuntimeConfig } from '@/config/runtime'
import { navigateTo } from '@/lib/navigation'
import type {
  InstalledSkill,
  InstalledPlugin,
  InstalledPluginListResponse,
  InstalledMCPServerConfig,
  MCPProviderInfo,
  MCPServer,
  PersonalSkill,
  PluginCatalogItem,
  SystemSkillCatalogItem,
  SystemSkillProviderError,
} from '@/types/api'
import { type InstalledPluginItem } from './PluginManagementRows'
import {
  CatalogSection,
  ConfirmUninstallDialog,
  McpMarketplaceCatalog,
  type CatalogItem,
  type CatalogSectionId,
} from './PluginCatalogSections'
import { CustomMcpDialog, type CustomMcpFormState } from './McpManagementSections'
import { serverConfigFromProviderServer, serverKeyFromProviderServer } from './mcp-utils'
import { parseOptionalStringRecordJson } from './mcp-json-import'
import { PluginCreateMenu } from './PluginCreateMenu'
import { PluginDetailView } from './PluginDetailView'
import { SkillUploadDialog } from './SkillUploadDialog'

type CatalogTab = 'mcp' | 'skills' | 'plugins'

interface PendingMcpUninstall {
  provider: MCPProviderInfo
  server: MCPServer
}

interface SystemSkillState {
  items: CatalogItem[]
  providerErrors: SystemSkillProviderError[]
  total: number
  page: number
  pageSize: number
  isLoading: boolean
  error: string | null
}

interface PersonalSkillState {
  items: CatalogItem[]
  isLoading: boolean
  error: string | null
}

interface McpMarketplaceState {
  providers: MCPProviderInfo[]
  providerServers: Record<string, MCPServer[]>
  providerErrors: Record<string, string>
  providerLoadingByKey: Record<string, boolean>
  isLoading: boolean
  error: string | null
}

interface PluginCatalogState {
  items: PluginCatalogItem[]
  isLoading: boolean
  error: string | null
}

const sections: CatalogSectionId[] = ['recommended', 'system', 'personal']
const SYSTEM_SKILL_PAGE_SIZE = 20
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

const skillIconByName: Record<string, Pick<CatalogItem, 'icon' | 'iconClassName'>> = {
  'image-gen': {
    icon: ImageIcon,
    iconClassName: 'bg-sky-100 text-sky-600',
  },
  'openai-docs': {
    icon: BookOpen,
    iconClassName: 'bg-orange-50 text-orange-500',
  },
}

function getSkillIcon(item: SystemSkillCatalogItem): Pick<CatalogItem, 'icon' | 'iconClassName'> {
  if (skillIconByName[item.name]) {
    return skillIconByName[item.name]
  }
  if (item.tags.includes('docs')) {
    return {
      icon: BookOpen,
      iconClassName: 'bg-orange-50 text-orange-500',
    }
  }
  if (
    item.tags.includes('image') ||
    item.capabilities.some(capability => capability.includes('image'))
  ) {
    return {
      icon: ImageIcon,
      iconClassName: 'bg-sky-100 text-sky-600',
    }
  }
  return {
    icon: Sparkles,
    iconClassName: 'bg-indigo-50 text-indigo-500',
  }
}

function toCatalogItem(item: SystemSkillCatalogItem): CatalogItem {
  const icon = getSkillIcon(item)
  return {
    id: item.id,
    providerKey: item.providerKey,
    skillKey: item.name,
    catalogItemId: item.id,
    installedSkillId: item.installedSkillId,
    name: item.displayName || item.name,
    description: item.description,
    version: item.version,
    author: item.author,
    tags: item.tags,
    section: 'system',
    icon: icon.icon,
    iconClassName: icon.iconClassName,
    installState: item.installState,
    enabled: item.enabled,
    sourceType: 'system',
  }
}

function getPersonalSkillId(item: PersonalSkill): number | null {
  const labels = item.metadata.labels
  const id = labels && typeof labels === 'object' ? labels.id : undefined
  const parsed = Number(id)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function getInstalledSkillKey(item: InstalledSkill): string {
  return item.spec.skillRef?.name || item.spec.source.skillKey
}

function toPersonalCatalogItem(
  item: PersonalSkill,
  installedBySkillKey: Map<string, InstalledSkill> = new Map()
): CatalogItem {
  const installed = installedBySkillKey.get(item.metadata.name)
  return {
    id: `personal-${item.metadata.name}`,
    name: item.spec.displayName || item.metadata.name,
    description: item.spec.description,
    personalSkillId: getPersonalSkillId(item),
    installedSkillId: installed ? getInstalledSkillId(installed) : null,
    version: item.spec.version,
    author: item.spec.author,
    tags: item.spec.tags ?? [],
    section: 'personal',
    icon: Sparkles,
    iconClassName: 'bg-teal-50 text-teal-600',
    installState: installed?.spec.installState ?? 'not_installed',
    enabled: installed?.spec.enabled ?? false,
    sourceType: 'personal',
  }
}

function getInstalledSkillId(item: InstalledSkill): number | null {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : undefined
  const parsed = Number(id)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function toInstalledPluginItem(item: InstalledPlugin): InstalledPluginItem {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : undefined
  const components = item.spec.components
  return {
    id: Number(id ?? 0),
    ids: Number(id ?? 0) > 0 ? [Number(id ?? 0)] : [],
    name: item.spec.displayName || item.spec.source.pluginKey,
    description: item.spec.description,
    enabled: item.spec.enabled,
    version: item.spec.version,
    sourceType: item.spec.source.type,
    runtimes: [item.spec.runtime],
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
    rawVariants: [item],
  }
}

function componentCountsFromPlugin(
  components: PluginCatalogItem['components']
): Record<string, number> {
  return {
    skills: components.skills.length,
    commands: components.commands.length,
    agents: components.agents.length,
    mcp: components.mcps.length,
    hooks: components.hooks.length,
    lsp: components.lsps.length,
    monitors: components.monitors.length,
    bin: components.bins.length,
  }
}

function getKindIdFromMetadata(metadata: Record<string, unknown>): number | null {
  const labels = metadata['labels']
  const id =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : undefined
  const parsed = Number(id)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function serverConfigFromCustomForm(form: CustomMcpFormState): InstalledMCPServerConfig {
  if (form.type === 'stdio') {
    return {
      type: 'stdio',
      command: form.command.trim(),
      args: form.args
        .split(/\s+/)
        .map(arg => arg.trim())
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

function createDefaultSystemSkillApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createSystemSkillApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function createDefaultMcpApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createMcpApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function createDefaultPluginApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createPluginApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function tabClassName(selected: boolean) {
  return [
    'h-7 flex-1 rounded-md px-3 text-[13px] font-semibold leading-[18px] transition-colors md:flex-none',
    selected
      ? 'bg-background text-text-primary shadow-[0_1px_6px_rgba(15,23,42,0.10)]'
      : 'text-text-secondary hover:text-text-primary',
  ].join(' ')
}

function SystemPluginCatalogRow({
  plugin,
  installLabel,
  updateLabel,
  enabledLabel,
  onInstall,
  onUpdate,
}: {
  plugin: PluginCatalogItem
  installLabel: string
  updateLabel: string
  enabledLabel: string
  onInstall: () => void
  onUpdate: () => void
}) {
  const counts = componentCountsFromPlugin(plugin.components)
  const componentLabels = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} ${count}`)
  const safeId = String(plugin.id).replace(/[^a-zA-Z0-9_-]/g, '-')

  return (
    <article className="group flex min-h-[84px] items-center gap-3 rounded-2xl border border-border/70 bg-background px-3 py-3 shadow-sm hover:bg-surface sm:min-h-[74px] sm:gap-4 sm:rounded-lg sm:border-0 sm:bg-transparent sm:py-2 sm:shadow-none">
      <div
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
        data-testid={`system-plugin-icon-${safeId}`}
      >
        <Boxes className="h-6 w-6" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3
            className="min-w-0 flex-1 truncate text-base font-semibold leading-5 text-text-primary sm:text-[15px]"
            data-testid={`system-plugin-title-${safeId}`}
          >
            {plugin.displayName || plugin.name}
          </h3>
          {plugin.version && (
            <span className="shrink-0 rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-text-muted">
              {plugin.version}
            </span>
          )}
        </div>
        <p className="mt-1 max-h-10 overflow-hidden text-sm leading-5 text-text-secondary sm:truncate">
          {plugin.description || componentLabels.join(' · ')}
        </p>
      </div>
      {plugin.installState === 'update_available' ? (
        <button
          type="button"
          aria-label={updateLabel}
          data-testid={`system-plugin-update-${safeId}`}
          onClick={onUpdate}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface hover:bg-muted sm:h-8 sm:w-8 sm:rounded-lg"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      ) : plugin.installState === 'installed' ? (
        <span
          aria-label={enabledLabel}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-muted sm:h-8 sm:w-8 sm:rounded-lg"
        >
          <Check className="h-4 w-4" />
        </span>
      ) : (
        <button
          type="button"
          aria-label={installLabel}
          data-testid={`system-plugin-install-${safeId}`}
          onClick={onInstall}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface hover:bg-muted sm:h-8 sm:w-8 sm:rounded-lg"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </article>
  )
}

interface PluginsWorkspaceProps {
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
}

export function PluginsWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
}: PluginsWorkspaceProps) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const [activeTab, setActiveTab] = useState<CatalogTab>('plugins')
  const [query, setQuery] = useState('')
  const [sectionFilter, setSectionFilter] = useState<CatalogSectionId | 'all'>('all')
  const [pendingUninstallItem, setPendingUninstallItem] = useState<CatalogItem | null>(null)
  const [pendingUninstallMcp, setPendingUninstallMcp] = useState<PendingMcpUninstall | null>(null)
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false)
  const [showCustomMcpDialog, setShowCustomMcpDialog] = useState(false)
  const [showSkillUploadDialog, setShowSkillUploadDialog] = useState(false)
  const [selectedPluginId, setSelectedPluginId] = useState<number | null>(null)
  const [customMcpForm, setCustomMcpForm] = useState<CustomMcpFormState>(emptyCustomMcpForm)
  const [isCreatingCustomMcp, setIsCreatingCustomMcp] = useState(false)
  const [isUploadingSkill, setIsUploadingSkill] = useState(false)
  const [systemSkillPage, setSystemSkillPage] = useState(1)
  const systemSkillApi = useMemo(() => createDefaultSystemSkillApi(), [])
  const mcpApi = useMemo(() => createDefaultMcpApi(), [])
  const pluginApi = useMemo(() => createDefaultPluginApi(), [])
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginItem[]>([])
  const [pluginCatalogState, setPluginCatalogState] = useState<PluginCatalogState>({
    items: [],
    isLoading: true,
    error: null,
  })
  const [systemSkillState, setSystemSkillState] = useState<SystemSkillState>({
    items: [],
    providerErrors: [],
    total: 0,
    page: 1,
    pageSize: SYSTEM_SKILL_PAGE_SIZE,
    isLoading: true,
    error: null,
  })
  const [personalSkillState, setPersonalSkillState] = useState<PersonalSkillState>({
    items: [],
    isLoading: true,
    error: null,
  })
  const [mcpMarketplaceState, setMcpMarketplaceState] = useState<McpMarketplaceState>({
    providers: [],
    providerServers: {},
    providerErrors: {},
    providerLoadingByKey: {},
    isLoading: true,
    error: null,
  })
  const catalog = useMemo(
    () => (activeTab === 'skills' ? [...systemSkillState.items, ...personalSkillState.items] : []),
    [activeTab, personalSkillState.items, systemSkillState.items]
  )
  const normalizedQuery = query.trim().toLowerCase()
  const totalSkillPages = Math.max(1, Math.ceil(systemSkillState.total / systemSkillState.pageSize))
  const canGoToPreviousSkillPage = systemSkillState.page > 1
  const canGoToNextSkillPage = systemSkillState.page < totalSkillPages

  const updateCatalogItem = (itemId: string, updates: Partial<CatalogItem>) => {
    setSystemSkillState(previous => ({
      ...previous,
      items: previous.items.map(item => (item.id === itemId ? { ...item, ...updates } : item)),
    }))
  }

  const installSystemSkill = async (item: CatalogItem) => {
    if (item.sourceType === 'personal') {
      if (!item.personalSkillId) return

      setPersonalSkillState(previous => ({
        ...previous,
        items: previous.items.map(skill =>
          skill.id === item.id ? { ...skill, installState: 'installed', enabled: true } : skill
        ),
      }))

      try {
        const installed = await systemSkillApi.installPersonalSkill(item.personalSkillId)
        setPersonalSkillState(previous => ({
          ...previous,
          items: previous.items.map(skill =>
            skill.id === item.id
              ? {
                  ...skill,
                  installState: installed.spec.installState,
                  installedSkillId: getInstalledSkillId(installed),
                  enabled: installed.spec.enabled,
                }
              : skill
          ),
          error: null,
        }))
      } catch (error) {
        setPersonalSkillState(previous => ({
          ...previous,
          items: previous.items.map(skill =>
            skill.id === item.id
              ? {
                  ...skill,
                  installState: item.installState,
                  installedSkillId: item.installedSkillId,
                  enabled: item.enabled,
                }
              : skill
          ),
          error: error instanceof Error ? error.message : 'Failed to install personal skill',
        }))
      }
      return
    }

    if (!item.providerKey || !item.skillKey) return

    updateCatalogItem(item.id, { installState: 'installed', enabled: true })
    try {
      const installed = await systemSkillApi.installSystemSkill({
        providerKey: item.providerKey,
        skillKey: item.skillKey,
        catalogItemId: item.catalogItemId,
        displayName: item.name,
        description: item.description,
        version: item.version,
        author: item.author,
        tags: item.tags,
      })
      updateCatalogItem(item.id, {
        installState: installed.spec.installState,
        installedSkillId: getInstalledSkillId(installed),
        enabled: installed.spec.enabled,
      })
    } catch (error) {
      updateCatalogItem(item.id, {
        installState: 'not_installed',
        enabled: false,
      })
      setSystemSkillState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to install system skill',
      }))
    }
  }

  const uninstallSystemSkill = async (item: CatalogItem) => {
    if (item.sourceType === 'personal') {
      if (!item.installedSkillId) return

      setPersonalSkillState(previous => ({
        ...previous,
        items: previous.items.map(skill =>
          skill.id === item.id
            ? {
                ...skill,
                installState: 'not_installed',
                installedSkillId: null,
                enabled: false,
              }
            : skill
        ),
      }))

      try {
        await systemSkillApi.uninstallInstalledSystemSkill(item.installedSkillId)
      } catch (error) {
        setPersonalSkillState(previous => ({
          ...previous,
          items: previous.items.map(skill => (skill.id === item.id ? item : skill)),
          error: error instanceof Error ? error.message : 'Failed to uninstall personal skill',
        }))
      }
      return
    }

    if (!item.installedSkillId) return

    updateCatalogItem(item.id, {
      installState: 'not_installed',
      installedSkillId: null,
      enabled: false,
    })

    try {
      await systemSkillApi.uninstallInstalledSystemSkill(item.installedSkillId)
    } catch (error) {
      updateCatalogItem(item.id, {
        installState: item.installState,
        installedSkillId: item.installedSkillId,
        enabled: item.enabled,
      })
      setSystemSkillState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to uninstall system skill',
      }))
    }
  }

  const loadMcpProviderServers = useCallback(
    (providerKey: string) => {
      setMcpMarketplaceState(previous => ({
        ...previous,
        providerLoadingByKey: {
          ...previous.providerLoadingByKey,
          [providerKey]: true,
        },
        providerErrors: {
          ...previous.providerErrors,
          [providerKey]: '',
        },
      }))

      mcpApi
        .listProviderServers(providerKey)
        .then(response => {
          setMcpMarketplaceState(previous => ({
            ...previous,
            providerServers: {
              ...previous.providerServers,
              [providerKey]: response.success ? response.servers : [],
            },
            providerErrors: {
              ...previous.providerErrors,
              [providerKey]: response.success ? '' : response.message,
            },
          }))
        })
        .catch((error: Error) => {
          setMcpMarketplaceState(previous => ({
            ...previous,
            providerErrors: {
              ...previous.providerErrors,
              [providerKey]: error.message,
            },
          }))
        })
        .finally(() => {
          setMcpMarketplaceState(previous => ({
            ...previous,
            providerLoadingByKey: {
              ...previous.providerLoadingByKey,
              [providerKey]: false,
            },
          }))
        })
    },
    [mcpApi]
  )

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
      .then(item => {
        setMcpMarketplaceState(previous => ({
          ...previous,
          providerServers: {
            ...previous.providerServers,
            [provider.key]: (previous.providerServers[provider.key] ?? []).map(candidate =>
              candidate.id === server.id
                ? {
                    ...candidate,
                    installState: 'installed',
                    installedMcpId: getKindIdFromMetadata(item.metadata),
                    enabled: item.spec.enabled,
                  }
                : candidate
            ),
          },
        }))
      })
  }

  const uninstallProviderServer = (provider: MCPProviderInfo, server: MCPServer) => {
    if (!server.installedMcpId) return

    mcpApi.uninstallInstalledMcp(server.installedMcpId).then(() => {
      setMcpMarketplaceState(previous => ({
        ...previous,
        providerServers: {
          ...previous.providerServers,
          [provider.key]: (previous.providerServers[provider.key] ?? []).map(candidate =>
            candidate.id === server.id
              ? {
                  ...candidate,
                  installState: 'not_installed',
                  installedMcpId: null,
                  enabled: false,
                }
              : candidate
          ),
        },
      }))
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
      .then(() => {
        setCustomMcpForm(emptyCustomMcpForm)
        setShowCustomMcpDialog(false)
      })
      .finally(() => setIsCreatingCustomMcp(false))
  }

  const uploadPersonalSkill = async (file: File, name: string) => {
    setIsUploadingSkill(true)
    try {
      const uploaded = await systemSkillApi.uploadPersonalSkill(file, name)
      const personalSkillId = getPersonalSkillId(uploaded)
      const installed = personalSkillId
        ? await systemSkillApi.installPersonalSkill(personalSkillId)
        : null
      const catalogItem = toPersonalCatalogItem(
        uploaded,
        installed ? new Map([[getInstalledSkillKey(installed), installed]]) : new Map()
      )
      setPersonalSkillState(previous => ({
        ...previous,
        items: [catalogItem, ...previous.items.filter(item => item.id !== catalogItem.id)],
        error: null,
      }))
      setSectionFilter('personal')
      setShowSkillUploadDialog(false)
    } catch (error) {
      setPersonalSkillState(previous => ({
        ...previous,
        error: error instanceof Error ? error.message : 'Failed to upload personal skill',
      }))
      throw error
    } finally {
      setIsUploadingSkill(false)
    }
  }

  const updateCatalogAfterInstall = (
    systemPluginId: number,
    response: InstalledPluginListResponse
  ) => {
    const items = response.items.map(toInstalledPluginItem)
    const installedIds = new Set(items.map(item => item.id))
    const installedPluginIds = Object.fromEntries(
      items.map(item => [item.raw.spec.runtime, item.id])
    )
    const primaryItem =
      items.find(item => item.raw.spec.runtime === 'claudecode') ?? items[0] ?? null

    setInstalledPlugins(previous => [
      ...items,
      ...previous.filter(plugin => !installedIds.has(plugin.id)),
    ])
    setPluginCatalogState(previous => ({
      ...previous,
      items: previous.items.map(plugin =>
        plugin.id === systemPluginId
          ? {
              ...plugin,
              installState: 'installed',
              installedPluginId: primaryItem?.id ?? plugin.installedPluginId ?? null,
              installedPluginIds,
              installedChecksum: plugin.sourceChecksum,
            }
          : plugin
      ),
    }))
  }

  const installCatalogPlugin = async (plugin: PluginCatalogItem) => {
    const installed = await pluginApi.installSystemPlugin(plugin.id)
    updateCatalogAfterInstall(plugin.id, installed)
  }

  const updateCatalogPlugin = async (plugin: PluginCatalogItem) => {
    const installed = await pluginApi.updateSystemPlugin(plugin.id)
    updateCatalogAfterInstall(plugin.id, installed)
  }

  const toggleInstalledPlugin = (id: number) => {
    const plugin = installedPlugins.find(item => item.id === id)
    if (!plugin) return

    setInstalledPlugins(previous =>
      previous.map(item => (item.id === id ? { ...item, enabled: !item.enabled } : item))
    )
    pluginApi.updateInstalledPlugin(id, { enabled: !plugin.enabled }).catch(() => {
      setInstalledPlugins(previous =>
        previous.map(item => (item.id === id ? { ...item, enabled: plugin.enabled } : item))
      )
    })
  }

  const togglePluginComponent = (id: number, componentKey: string, enabled: boolean) => {
    const plugin = installedPlugins.find(item => item.id === id)
    if (!plugin) return

    const previousStates = plugin.raw.spec.componentStates || {}
    const nextStates = { ...previousStates, [componentKey]: enabled }
    setInstalledPlugins(previous =>
      previous.map(item =>
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
          : item
      )
    )
    pluginApi
      .updateInstalledPlugin(id, {
        componentStates: { [componentKey]: enabled },
      })
      .then(updated => {
        const nextItem = toInstalledPluginItem(updated)
        setInstalledPlugins(previous => previous.map(item => (item.id === id ? nextItem : item)))
      })
      .catch(() => {
        setInstalledPlugins(previous => previous.map(item => (item.id === id ? plugin : item)))
      })
  }

  const uninstallInstalledPlugin = (id: number) => {
    const plugin = installedPlugins.find(item => item.id === id)
    if (!plugin) return

    setInstalledPlugins(previous => previous.filter(item => item.id !== id))
    setSelectedPluginId(current => (current === id ? null : current))
    pluginApi.uninstallInstalledPlugin(id).catch(() => {
      setInstalledPlugins(previous => [...previous, plugin])
    })
  }

  useEffect(() => {
    if (activeTab !== 'skills') return

    let isCurrent = true

    setSystemSkillState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    systemSkillApi
      .listSystemSkills({
        keyword: normalizedQuery || undefined,
        page: systemSkillPage,
        pageSize: SYSTEM_SKILL_PAGE_SIZE,
        category: 'system',
      })
      .then(response => {
        if (!isCurrent) return

        setSystemSkillState({
          items: response.items.map(toCatalogItem),
          providerErrors: response.providerErrors,
          total: response.total,
          page: response.page,
          pageSize: response.pageSize,
          isLoading: false,
          error: null,
        })
      })
      .catch(error => {
        if (!isCurrent) return

        setSystemSkillState({
          items: [],
          providerErrors: [],
          total: 0,
          page: systemSkillPage,
          pageSize: SYSTEM_SKILL_PAGE_SIZE,
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to load system skills',
        })
      })

    return () => {
      isCurrent = false
    }
  }, [activeTab, normalizedQuery, systemSkillApi, systemSkillPage])

  useEffect(() => {
    let isCurrent = true

    setPersonalSkillState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    Promise.all([systemSkillApi.listPersonalSkills(), systemSkillApi.listInstalledSystemSkills()])
      .then(([personalResponse, installedResponse]) => {
        if (!isCurrent) return
        const personalInstalled = installedResponse.items.filter(
          item => item.spec.source.type === 'personal'
        )
        const installedBySkillKey = new Map(
          personalInstalled.map(item => [getInstalledSkillKey(item), item])
        )
        setPersonalSkillState({
          items: personalResponse.items.map(item =>
            toPersonalCatalogItem(item, installedBySkillKey)
          ),
          isLoading: false,
          error: null,
        })
      })
      .catch((error: Error) => {
        if (!isCurrent) return
        setPersonalSkillState({
          items: [],
          isLoading: false,
          error: error.message,
        })
      })

    return () => {
      isCurrent = false
    }
  }, [systemSkillApi])

  useEffect(() => {
    if (activeTab !== 'mcp') return

    let isCurrent = true
    setMcpMarketplaceState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    mcpApi
      .listProviders()
      .then(response => {
        if (!isCurrent) return

        setMcpMarketplaceState(previous => ({
          ...previous,
          providers: response.providers,
          isLoading: false,
          error: null,
        }))

        response.providers
          .filter(provider => !provider.requires_token || provider.has_token)
          .forEach(provider => loadMcpProviderServers(provider.key))
      })
      .catch((error: Error) => {
        if (!isCurrent) return
        setMcpMarketplaceState(previous => ({
          ...previous,
          providers: [],
          isLoading: false,
          error: error.message,
        }))
      })

    return () => {
      isCurrent = false
    }
  }, [activeTab, loadMcpProviderServers, mcpApi])

  useEffect(() => {
    let isCurrent = true
    setPluginCatalogState(previous => ({
      ...previous,
      isLoading: true,
      error: null,
    }))

    Promise.all([pluginApi.listPluginCatalog(), pluginApi.listInstalledPlugins()])
      .then(([catalogResponse, installedResponse]) => {
        if (!isCurrent) return
        setPluginCatalogState({
          items: catalogResponse.items,
          isLoading: false,
          error: null,
        })
        setInstalledPlugins(installedResponse.items.map(toInstalledPluginItem))
      })
      .catch(() => {
        if (!isCurrent) return
        setPluginCatalogState({
          items: [],
          isLoading: false,
          error: 'Failed to load plugins',
        })
        setInstalledPlugins([])
      })

    return () => {
      isCurrent = false
    }
  }, [pluginApi])

  const filteredItems = useMemo(
    () =>
      catalog.filter(item => {
        const sectionMatches = sectionFilter === 'all' || item.section === sectionFilter
        const queryMatches =
          !normalizedQuery ||
          item.name.toLowerCase().includes(normalizedQuery) ||
          item.description.toLowerCase().includes(normalizedQuery)

        return sectionMatches && queryMatches
      }),
    [catalog, normalizedQuery, sectionFilter]
  )

  const filteredPluginCatalog = useMemo(
    () =>
      pluginCatalogState.items.filter(plugin => {
        if (!normalizedQuery) return true
        return (
          plugin.displayName.toLowerCase().includes(normalizedQuery) ||
          plugin.description.toLowerCase().includes(normalizedQuery) ||
          plugin.name.toLowerCase().includes(normalizedQuery)
        )
      }),
    [pluginCatalogState.items, normalizedQuery]
  )
  const selectedPlugin = useMemo(
    () =>
      selectedPluginId === null
        ? null
        : (installedPlugins.find(plugin => plugin.id === selectedPluginId) ?? null),
    [installedPlugins, selectedPluginId]
  )

  const filteredMcpProviders = useMemo(
    () =>
      mcpMarketplaceState.providers.filter(provider => {
        if (!normalizedQuery) return true

        return (
          provider.name.toLowerCase().includes(normalizedQuery) ||
          (provider.name_en ?? '').toLowerCase().includes(normalizedQuery) ||
          provider.description.toLowerCase().includes(normalizedQuery) ||
          provider.key.toLowerCase().includes(normalizedQuery) ||
          (mcpMarketplaceState.providerServers[provider.key] ?? []).some(
            server =>
              server.name.toLowerCase().includes(normalizedQuery) ||
              (server.description ?? '').toLowerCase().includes(normalizedQuery)
          )
        )
      }),
    [mcpMarketplaceState.providers, mcpMarketplaceState.providerServers, normalizedQuery]
  )
  const filteredMcpProviderServers = useMemo(() => {
    if (!normalizedQuery) return mcpMarketplaceState.providerServers

    return Object.fromEntries(
      Object.entries(mcpMarketplaceState.providerServers).map(([providerKey, servers]) => [
        providerKey,
        mcpMarketplaceState.providers.some(
          provider =>
            provider.key === providerKey &&
            (provider.name.toLowerCase().includes(normalizedQuery) ||
              (provider.name_en ?? '').toLowerCase().includes(normalizedQuery) ||
              provider.description.toLowerCase().includes(normalizedQuery) ||
              provider.key.toLowerCase().includes(normalizedQuery))
        )
          ? servers
          : servers.filter(
              server =>
                server.name.toLowerCase().includes(normalizedQuery) ||
                (server.description ?? '').toLowerCase().includes(normalizedQuery)
            ),
      ])
    )
  }, [mcpMarketplaceState.providerServers, mcpMarketplaceState.providers, normalizedQuery])
  const systemSkillPagination =
    activeTab === 'skills' &&
    !systemSkillState.isLoading &&
    !systemSkillState.error &&
    systemSkillState.total > 0 ? (
      <div
        data-testid="system-skills-pagination"
        className="flex items-center justify-end gap-2 pt-1 text-xs text-text-muted"
      >
        <button
          type="button"
          data-testid="system-skills-previous-page-button"
          disabled={!canGoToPreviousSkillPage}
          onClick={() => setSystemSkillPage(page => Math.max(1, page - 1))}
          className="h-11 rounded-lg px-3 font-semibold text-text-secondary hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
        >
          {t('workbench.plugins_previous_page', '上一页')}
        </button>
        <span className="min-w-14 text-center font-medium">
          {systemSkillState.page} / {totalSkillPages}
        </span>
        <button
          type="button"
          data-testid="system-skills-next-page-button"
          disabled={!canGoToNextSkillPage}
          onClick={() => setSystemSkillPage(page => page + 1)}
          className="h-11 rounded-lg px-3 font-semibold text-text-secondary hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
        >
          {t('workbench.plugins_next_page', '下一页')}
        </button>
      </div>
    ) : null

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
    <main
      data-testid="plugins-workspace"
      className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary"
    >
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-xl">
        <DesktopTopBar
          testId="plugins-topbar"
          className={[
            'mx-auto h-12 max-w-[1420px] pl-20 pr-5 md:h-[52px] md:pr-7',
            sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
          ].join(' ')}
          left={
            <>
              {topBarLeftActions}
              <div
                className="inline-flex w-full rounded-lg bg-surface p-0.5 md:w-fit"
                role="tablist"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'plugins'}
                  className={tabClassName(activeTab === 'plugins')}
                  onClick={() => {
                    setSelectedPluginId(null)
                    setActiveTab('plugins')
                  }}
                >
                  {t('workbench.plugin_management_tab_plugins', '插件')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'skills'}
                  className={tabClassName(activeTab === 'skills')}
                  onClick={() => {
                    setSelectedPluginId(null)
                    setActiveTab('skills')
                  }}
                >
                  {t('workbench.skills_tab', '技能')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'mcp'}
                  className={tabClassName(activeTab === 'mcp')}
                  onClick={() => {
                    setSelectedPluginId(null)
                    setActiveTab('mcp')
                  }}
                >
                  {t('workbench.plugin_management_tab_mcp', 'MCP')}
                </button>
              </div>
            </>
          }
          dragRegionClassName="hidden md:block"
          right={
            <div className="hidden items-center gap-5 overflow-visible md:flex">
              <button
                type="button"
                data-testid="plugins-manage-button"
                className="flex h-7 min-w-[44px] items-center gap-1.5 rounded-lg bg-transparent px-2 text-[13px] font-medium leading-[18px] transition-colors hover:bg-black/[0.06] active:bg-black/[0.10]"
                onClick={() => navigateTo('/plugins/manage')}
              >
                <Settings className="h-[18px] w-[18px] stroke-[2]" />
                {t('workbench.plugins_manage', '管理')}
              </button>
              {!isMobile && (
                <PluginCreateMenu
                  isOpen={isCreateMenuOpen}
                  onToggle={() => setIsCreateMenuOpen(previous => !previous)}
                  onCreateSkill={() => {
                    setIsCreateMenuOpen(false)
                    setShowSkillUploadDialog(true)
                  }}
                  onCreateMcp={() => {
                    setIsCreateMenuOpen(false)
                    setShowCustomMcpDialog(true)
                  }}
                />
              )}
              <button
                type="button"
                aria-label={t('workbench.plugins_more_actions', '更多操作')}
                className={DESKTOP_TOP_BAR_BUTTON_CLASS}
              >
                <MoreHorizontal />
              </button>
            </div>
          }
        />
      </div>

      <div className="mx-auto flex w-full max-w-[840px] flex-col gap-5 px-5 pb-10 pt-1 md:px-8 md:pt-[3px]">
        <section className="hidden flex-col items-center md:flex">
          <h1 className="text-center text-[24px] font-medium leading-8 tracking-normal text-text-primary md:text-[28px]">
            {t('workbench.plugins_title', '让 Wework 按你的方式工作')}
          </h1>
        </section>

        <div className="sticky top-12 z-30 mt-0 grid w-full grid-cols-1 gap-2.5 py-0 md:-mt-1 md:grid-cols-[minmax(0,1fr)_auto] md:py-1.5">
          <div className="grid w-full grid-cols-[minmax(0,1fr)_44px] items-center gap-2 md:flex md:min-w-0 md:flex-1">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">
                {t('workbench.plugins_search_placeholder', '搜索技能')}
              </span>
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                value={query}
                onChange={event => {
                  setQuery(event.target.value)
                  setSystemSkillPage(1)
                }}
                placeholder={
                  activeTab === 'skills'
                    ? t('workbench.plugins_search_placeholder', '搜索技能')
                    : activeTab === 'mcp'
                      ? t('workbench.plugins_search_mcp', '搜索 MCP')
                      : t('workbench.plugins_search_plugins', '搜索插件')
                }
                data-testid="plugins-search-input"
                className="h-11 w-full rounded-lg border border-border bg-background pl-10 pr-3 text-[13px] leading-[18px] text-text-primary shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition-colors placeholder:text-text-muted focus:border-text-muted"
              />
            </label>
            {isMobile && (
              <div className="md:hidden">
                <PluginCreateMenu
                  compact
                  isOpen={isCreateMenuOpen}
                  onToggle={() => setIsCreateMenuOpen(previous => !previous)}
                  onCreateSkill={() => {
                    setIsCreateMenuOpen(false)
                    setShowSkillUploadDialog(true)
                  }}
                  onCreateMcp={() => {
                    setIsCreateMenuOpen(false)
                    setShowCustomMcpDialog(true)
                  }}
                />
              </div>
            )}
          </div>
          {activeTab === 'skills' && (
            <>
              <div
                className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 md:hidden"
                data-testid="plugins-mobile-section-filter"
              >
                {(['all', ...sections] as const).map(section => (
                  <button
                    key={section}
                    type="button"
                    data-testid={`plugins-mobile-section-filter-${section}`}
                    aria-pressed={sectionFilter === section}
                    onClick={() => setSectionFilter(section)}
                    className={[
                      'h-11 shrink-0 rounded-xl px-4 text-sm font-semibold transition-colors',
                      sectionFilter === section
                        ? 'bg-text-primary text-background'
                        : 'bg-surface text-text-secondary hover:text-text-primary',
                    ].join(' ')}
                  >
                    {section === 'all'
                      ? t('workbench.plugins_filter_all', '全部')
                      : section === 'recommended'
                        ? t('workbench.plugins_recommended', '推荐')
                        : section === 'system'
                          ? t('workbench.plugins_system', '系统')
                          : t('workbench.plugins_personal', '个人')}
                  </button>
                ))}
              </div>
              <select
                value={sectionFilter}
                data-testid="plugins-section-filter"
                onChange={event => setSectionFilter(event.target.value as CatalogSectionId | 'all')}
                className="hidden h-10 rounded-xl border-0 bg-surface px-4 text-sm font-semibold text-text-primary outline-none md:block"
              >
                <option value="all">{t('workbench.plugins_filter_all', '全部')}</option>
                <option value="recommended">{t('workbench.plugins_recommended', '推荐')}</option>
                <option value="system">{t('workbench.plugins_system', '系统')}</option>
                <option value="personal">{t('workbench.plugins_personal', '个人')}</option>
              </select>
            </>
          )}
        </div>

        <section className="space-y-8">
          {activeTab === 'mcp' ? (
            <McpMarketplaceCatalog
              providers={filteredMcpProviders}
              providerServers={filteredMcpProviderServers}
              providerErrors={mcpMarketplaceState.providerErrors}
              providerLoadingByKey={mcpMarketplaceState.providerLoadingByKey}
              isLoading={mcpMarketplaceState.isLoading}
              error={mcpMarketplaceState.error}
              onManage={() => navigateTo('/plugins/manage')}
              onInstall={installProviderServer}
              onRequestUninstall={(provider, server) =>
                setPendingUninstallMcp({ provider, server })
              }
            />
          ) : activeTab === 'plugins' ? (
            pluginCatalogState.isLoading ? (
              <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-text-secondary">
                {t('workbench.plugins_loading_plugins', '正在加载插件')}
              </div>
            ) : pluginCatalogState.error ? (
              <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-text-secondary">
                {t('workbench.plugins_load_failed', '加载插件失败')}
              </div>
            ) : filteredPluginCatalog.length === 0 ? (
              <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 text-sm font-semibold">
                <div className="text-text-secondary">
                  {t('workbench.plugins_no_available_plugins')}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {filteredPluginCatalog.map(plugin => (
                  <SystemPluginCatalogRow
                    key={plugin.id}
                    plugin={plugin}
                    enabledLabel={t('workbench.plugins_enabled', '已启用')}
                    installLabel={t('workbench.plugins_install', '安装')}
                    updateLabel={t('workbench.plugins_update', '更新')}
                    onInstall={() => void installCatalogPlugin(plugin)}
                    onUpdate={() => void updateCatalogPlugin(plugin)}
                  />
                ))}
              </div>
            )
          ) : activeTab === 'skills' &&
            systemSkillState.isLoading &&
            personalSkillState.isLoading ? (
            <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-text-secondary">
              {t('workbench.plugins_loading_skills', '正在加载技能')}
            </div>
          ) : activeTab === 'skills' && systemSkillState.error ? (
            <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold text-text-secondary">
              {t('workbench.plugins_load_failed', '加载技能失败')}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex min-h-[220px] items-center justify-center text-sm font-semibold">
              {t('workbench.plugins_no_search_results', '找不到匹配的技能')}
            </div>
          ) : (
            sections.map(section => {
              const sectionItems = filteredItems.filter(item => item.section === section)
              if (sectionItems.length === 0) return null

              const catalogSection = (
                <CatalogSection
                  title={t(`workbench.plugins_${section}`, section)}
                  items={sectionItems}
                  enabledLabel={t('workbench.plugins_enabled', '已启用')}
                  installLabel={t('workbench.plugins_install', '安装')}
                  updateLabel={t('workbench.plugins_update', '更新')}
                  uninstallLabel={t('workbench.plugins_uninstall', '卸载')}
                  onInstall={installSystemSkill}
                  onRequestUninstall={setPendingUninstallItem}
                />
              )

              if (section === 'system') {
                return (
                  <div key={section} className="space-y-5">
                    {catalogSection}
                    {systemSkillPagination}
                  </div>
                )
              }

              return <div key={section}>{catalogSection}</div>
            })
          )}
          {activeTab === 'skills' && systemSkillState.providerErrors.length > 0 && (
            <div className="text-xs text-text-muted">
              {t('workbench.plugins_provider_partial_error', '部分技能来源暂不可用')}
            </div>
          )}
          {activeTab === 'skills' && personalSkillState.error && (
            <div className="text-xs text-text-muted">
              {t('workbench.plugins_personal_skill_error', '个人技能暂不可用')}
            </div>
          )}
        </section>
      </div>
      {pendingUninstallItem && (
        <ConfirmUninstallDialog
          item={pendingUninstallItem}
          title={t('workbench.plugins_uninstall_confirm_title', '卸载技能？')}
          description={t(
            'workbench.plugins_uninstall_confirm_description',
            '卸载后可以随时重新安装。'
          )}
          cancelLabel={t('workbench.plugins_uninstall_cancel', '取消')}
          confirmLabel={t('workbench.plugins_uninstall_confirm', '卸载')}
          onCancel={() => setPendingUninstallItem(null)}
          onConfirm={() => {
            const item = pendingUninstallItem
            setPendingUninstallItem(null)
            void uninstallSystemSkill(item)
          }}
        />
      )}
      {pendingUninstallMcp && (
        <ConfirmUninstallDialog
          item={{ name: pendingUninstallMcp.server.name }}
          title={t('workbench.plugins_uninstall_mcp_confirm_title', '卸载 MCP？')}
          description={t(
            'workbench.plugins_uninstall_mcp_confirm_description',
            '卸载后可以在市场中重新安装。'
          )}
          cancelLabel={t('workbench.plugins_uninstall_cancel', '取消')}
          confirmLabel={t('workbench.plugins_uninstall_confirm', '卸载')}
          confirmTestId="mcp-market-confirm-uninstall-button"
          onCancel={() => setPendingUninstallMcp(null)}
          onConfirm={() => {
            const item = pendingUninstallMcp
            setPendingUninstallMcp(null)
            uninstallProviderServer(item.provider, item.server)
          }}
        />
      )}
      {showCustomMcpDialog && (
        <CustomMcpDialog
          form={customMcpForm}
          isSubmitting={isCreatingCustomMcp}
          onCancel={() => setShowCustomMcpDialog(false)}
          onChange={nextForm => setCustomMcpForm(nextForm)}
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
    </main>
  )
}
