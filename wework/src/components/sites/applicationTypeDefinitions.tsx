import type { ReactNode } from 'react'
import { Globe2, Smartphone } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ApplicationCapability, SiteAppType, SiteListItem } from '@/api/sites'
import {
  WEGENT_MINI_PROGRAM_PLUGIN_NAME,
  WEGENT_SITES_PLUGIN_NAME,
} from '@/features/plugins/builtinPlugins'
import { MiniProgramApplicationRow, SiteApplicationRow } from './ApplicationRows'
import type { ApplicationRowContext } from './ApplicationRows'

export interface ApplicationCopy {
  key: string
  fallback: string
}

export interface ApplicationCreateStrategy {
  label: ApplicationCopy
  testId: string
  pluginName: string
  prompt?: ApplicationCopy
}

export interface ApplicationTypeDefinition {
  appType: SiteAppType
  icon: LucideIcon
  capabilities: readonly ApplicationCapability[]
  tab: ApplicationCopy
  search: ApplicationCopy
  loading: ApplicationCopy
  loadFailed: ApplicationCopy
  refresh: ApplicationCopy
  emptyTitle: ApplicationCopy
  emptyDescription: ApplicationCopy
  columns: readonly ApplicationCopy[]
  columnGridClassName: string
  create: ApplicationCreateStrategy
  isItem: (item: SiteListItem) => boolean
  renderRow: (item: SiteListItem, context: ApplicationRowContext) => ReactNode
}

export interface ResolvedApplicationTypeDefinition {
  definition: ApplicationTypeDefinition
  capabilities: ReadonlySet<ApplicationCapability>
}

const siteDefinition: ApplicationTypeDefinition = {
  appType: 'web',
  icon: Globe2,
  capabilities: ['create', 'publish', 'delete'],
  tab: { key: 'site_tab', fallback: '站点' },
  search: { key: 'search', fallback: '搜索站点' },
  loading: { key: 'loading', fallback: '正在加载站点' },
  loadFailed: { key: 'load_failed', fallback: '站点加载失败' },
  refresh: { key: 'refresh', fallback: '刷新站点' },
  emptyTitle: { key: 'empty_title', fallback: '还没有站点' },
  emptyDescription: { key: 'empty_description', fallback: '通过 Sites 创建你的第一个站点' },
  columns: [
    { key: 'site_column', fallback: '站点' },
    { key: 'network_column', fallback: '网络' },
  ],
  columnGridClassName: 'grid-cols-[minmax(0,1fr)_minmax(240px,0.55fr)] md:gap-8',
  create: {
    label: { key: 'create_site', fallback: '站点' },
    testId: 'sites-create-site-menu-item',
    pluginName: WEGENT_SITES_PLUGIN_NAME,
  },
  isItem: item => item.app_type === 'web',
  renderRow: (item, context) =>
    item.app_type === 'web' ? <SiteApplicationRow site={item} context={context} /> : null,
}

const miniProgramDefinition: ApplicationTypeDefinition = {
  appType: 'miniapp',
  icon: Smartphone,
  capabilities: ['create', 'open_experience'],
  tab: { key: 'mini_program_tab', fallback: '小程序' },
  search: { key: 'mini_program_search', fallback: '搜索小程序' },
  loading: { key: 'mini_program_loading', fallback: '正在加载小程序' },
  loadFailed: { key: 'mini_program_load_failed', fallback: '小程序加载失败' },
  refresh: { key: 'mini_program_refresh', fallback: '刷新小程序' },
  emptyTitle: { key: 'mini_program_empty_title', fallback: '还没有小程序' },
  emptyDescription: {
    key: 'mini_program_empty_description',
    fallback: '创建你的第一个小程序',
  },
  columns: [
    { key: 'mini_program_column', fallback: '小程序' },
    { key: 'status_column', fallback: '状态' },
    { key: 'qrcode_column', fallback: '二维码' },
    { key: 'link_column', fallback: '链接' },
    { key: 'updated_column', fallback: '最近更新' },
  ],
  columnGridClassName: 'grid-cols-[minmax(0,1fr)_120px_120px_120px_120px]',
  create: {
    label: { key: 'create_mini_program', fallback: '小程序' },
    testId: 'sites-create-mini-program-menu-item',
    pluginName: WEGENT_MINI_PROGRAM_PLUGIN_NAME,
    prompt: { key: 'create_mini_program_prompt', fallback: '创建并发布一个小程序' },
  },
  isItem: item => item.app_type === 'miniapp',
  renderRow: (item, context) =>
    item.app_type === 'miniapp' ? (
      <MiniProgramApplicationRow program={item} capabilities={context.capabilities} />
    ) : null,
}

export const APPLICATION_TYPE_DEFINITIONS: readonly ApplicationTypeDefinition[] = [
  siteDefinition,
  miniProgramDefinition,
]

const APPLICATION_TYPE_DEFINITION_BY_NAME = new Map(
  APPLICATION_TYPE_DEFINITIONS.map(definition => [definition.appType, definition])
)

export const DEFAULT_APPLICATION_TYPE: SiteAppType = 'web'

export function getApplicationTypeDefinition(
  appType: string
): ApplicationTypeDefinition | undefined {
  return APPLICATION_TYPE_DEFINITION_BY_NAME.get(appType as SiteAppType)
}

export function defaultResolvedApplicationTypes(): ResolvedApplicationTypeDefinition[] {
  return APPLICATION_TYPE_DEFINITIONS.map(definition => ({
    definition,
    capabilities: new Set(definition.capabilities),
  }))
}
