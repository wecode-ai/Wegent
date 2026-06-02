import {
  ChevronRight,
  MoreHorizontal,
  Search,
} from 'lucide-react'
import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createHttpClient } from '@/api/http'
import { createMcpApi } from '@/api/mcps'
import { createSystemSkillApi } from '@/api/systemSkills'
import { getRuntimeConfig } from '@/config/runtime'
import { navigateTo } from '@/lib/navigation'
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
  InstalledSkillRow,
  type InstalledMcpItem,
  type InstalledSkillItem,
} from './PluginManagementRows'
import { PluginCreateMenu } from './PluginCreateMenu'
import { SkillUploadDialog } from './SkillUploadDialog'
import type {
  InstalledMCP,
  InstalledMCPServerConfig,
  InstalledSkill,
  MCPProviderInfo,
  MCPServer,
  PersonalSkill,
} from '@/types/api'

type ManagementTab = 'mcp' | 'skills' | 'integrations'

const tabs: Array<{
  id: ManagementTab
  labelKey: string
  fallback: string
}> = [
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
    id: 'integrations',
    labelKey: 'plugin_management_tab_integrations',
    fallback: '集成',
  },
]

function tabClassName(selected: boolean) {
  return [
    'h-10 rounded-xl px-3 text-sm font-semibold transition-colors',
    selected
      ? 'bg-surface text-text-primary'
      : 'text-text-muted hover:text-text-primary',
  ].join(' ')
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
    sourceType: 'system',
  }
}

function getPersonalSkillId(item: PersonalSkill): number {
  const labels = item.metadata['labels']
  const id =
    labels && typeof labels === 'object'
      ? (labels as Record<string, unknown>).id
      : undefined
  return Number(id ?? 0)
}

function toPersonalSkillItem(item: PersonalSkill): InstalledSkillItem {
  return {
    id: getPersonalSkillId(item),
    name: item.spec.displayName || item.metadata.name,
    description: item.spec.description,
    enabled: item.spec.enabled ?? true,
    sourceType: 'personal',
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

export function PluginManagementWorkspace() {
  const { t } = useTranslation('common')
  const [activeTab, setActiveTab] = useState<ManagementTab>('mcp')
  const [query, setQuery] = useState('')
  const systemSkillApi = useMemo(() => createDefaultSystemSkillApi(), [])
  const mcpApi = useMemo(() => {
    const { apiBaseUrl } = getRuntimeConfig()
    return createMcpApi(createHttpClient({ baseUrl: apiBaseUrl }))
  }, [])
  const [installedMcps, setInstalledMcps] = useState<InstalledMcpItem[]>([])
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
  const [customMcpForm, setCustomMcpForm] =
    useState<CustomMcpFormState>(emptyCustomMcpForm)
  const [isCreatingCustomMcp, setIsCreatingCustomMcp] = useState(false)
  const [isUploadingSkill, setIsUploadingSkill] = useState(false)
  const [isLoadingMcps, setIsLoadingMcps] = useState(true)
  const [isLoadingSkills, setIsLoadingSkills] = useState(true)
  const normalizedQuery = query.trim().toLowerCase()

  useEffect(() => {
    let isCurrent = true

    let pendingSkillRequests = 2
    const finishSkillRequest = () => {
      pendingSkillRequests -= 1
      if (pendingSkillRequests === 0) {
        setIsLoadingSkills(false)
      }
    }

    systemSkillApi
      .listInstalledSystemSkills()
      .then((response) => {
        if (!isCurrent) return
        setInstalledSkills((previous) => [
          ...response.items.map(toInstalledSkillItem),
          ...previous.filter((skill) => skill.sourceType === 'personal'),
        ])
      })
      .catch(() => {
        if (!isCurrent) return
        setInstalledSkills((previous) =>
          previous.filter((skill) => skill.sourceType === 'personal'),
        )
      })
      .finally(() => {
        if (isCurrent) finishSkillRequest()
      })

    systemSkillApi
      .listPersonalSkills()
      .then((response) => {
        if (!isCurrent) return
        setInstalledSkills((previous) => [
          ...previous.filter((skill) => skill.sourceType === 'system'),
          ...response.items.map(toPersonalSkillItem),
        ])
      })
      .catch(() => {
        if (!isCurrent) return
        setInstalledSkills((previous) =>
          previous.filter((skill) => skill.sourceType === 'system'),
        )
      })
      .finally(() => {
        if (isCurrent) finishSkillRequest()
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
  }, [mcpApi, systemSkillApi])

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

    const request =
      skill.sourceType === 'system'
        ? systemSkillApi.updateInstalledSystemSkill(id, !skill.enabled)
        : systemSkillApi.updatePersonalSkillEnabled(id, !skill.enabled)
    request.catch(() => {
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
    const request =
      skill.sourceType === 'system'
        ? systemSkillApi.uninstallInstalledSystemSkill(id)
        : systemSkillApi.deletePersonalSkill(id)
    request.catch(() => setInstalledSkills((previous) => [...previous, skill]))
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
      const item = toPersonalSkillItem(uploaded)
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

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-base px-4 pb-5 pt-20 text-text-primary sm:px-7 sm:py-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <nav
          className="flex h-10 items-center gap-3 text-sm font-semibold"
          aria-label="breadcrumb"
        >
          <button
            type="button"
            className="text-text-muted hover:text-text-primary"
            onClick={() => navigateTo('/plugins')}
          >
            {t('workbench.plugins_tab', '插件')}
          </button>
          <ChevronRight className="h-4 w-4 text-text-muted" />
          <span>{t('workbench.plugins_manage', '管理')}</span>
        </nav>

        <div className="flex items-center gap-2 overflow-x-auto">
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
          />
          <button
            type="button"
            aria-label={t('workbench.plugins_more_actions', '更多操作')}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-text-secondary hover:bg-surface"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </header>

      <section className="mx-auto mt-8 flex w-full max-w-[940px] flex-col gap-7 sm:mt-16 sm:gap-9">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
          <div className="flex items-center gap-2 overflow-x-auto sm:gap-4" role="tablist">
            {tabs.map((tab) => {
              const count =
                tab.id === 'mcp'
                  ? installedMcps.length
                  : tab.id === 'skills'
                    ? installedSkills.length
                    : mcpProviders.length
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={tabClassName(activeTab === tab.id)}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {t(`workbench.${tab.labelKey}`, tab.fallback)}{' '}
                  <span className="text-text-muted">{count}</span>
                </button>
              )
            })}
          </div>

          <label className="relative w-full shrink-0 sm:w-[340px]">
            <span className="sr-only">
              {t('workbench.plugins_search_plugins', '搜索插件')}
            </span>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workbench.plugins_search_plugins', '搜索插件')}
              data-testid="plugin-management-search-input"
              className="h-11 w-full rounded-xl border border-border bg-base pl-11 pr-4 text-sm outline-none placeholder:text-text-muted focus:border-primary"
            />
          </label>
        </div>

        {activeTab === 'mcp' ? (
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
                <div className="text-sm font-semibold text-text-secondary">
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
                <div className="text-sm font-semibold text-text-secondary">
                  {t('workbench.plugins_no_installed_mcps', '暂无已安装 MCP')}
                </div>
              )}
            </section>

          </div>
        ) : activeTab === 'skills' ? (
          <div className="space-y-9">
            {isLoadingSkills ? (
              <div className="text-sm font-semibold text-text-secondary">
                {t('workbench.plugins_loading_skills', '正在加载技能')}
              </div>
            ) : (
              filteredInstalledSkills.map((skill) => (
                <InstalledSkillRow
                  key={skill.id}
                  skill={skill}
                  onToggle={() => toggleInstalledSkill(skill.id)}
                  onUninstall={() => uninstallInstalledSkill(skill.id)}
                />
              ))
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
            {filteredMcpProviders.map((provider) => (
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
            ))}
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
    </main>
  )
}
