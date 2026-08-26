import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'
import { WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from '@/features/dsh-runtime/dshUiSlots'

const electronHostInvokePath = '/wework/electron-host/v1/invoke'
const nativeFetch = globalThis.fetch.bind(globalThis)
let testAppPreferences: Record<string, unknown> = {}

const testApps = [
  {
    id: 'wework',
    labelKey: 'workbench.app_wework_label',
    label: '任务',
    descriptionKey: 'workbench.app_wework_description',
    description: '使用 AI 解决具体问题',
    mode: 'native',
    module: 'plugins/wework-ui-core-apps.js',
    path: '/',
    requiresAuth: true,
    workspaceKinds: ['task'],
  },
  {
    id: 'todo',
    labelKey: 'workbench.app_weloop_label',
    label: '项目空间',
    descriptionKey: 'workbench.app_weloop_description',
    description: '用 AI 管理项目的规划、执行与反馈',
    mode: 'native',
    module: 'plugins/wework-ui-core-apps.js',
    path: '/todo',
    requiresAuth: true,
    workspaceKinds: ['board'],
    hidden: true,
  },
  {
    id: 'wegent',
    labelKey: 'workbench.app_wegent_label',
    label: '智能体',
    descriptionKey: 'workbench.app_wegent_description',
    description: '构建并交付可嵌入业务的云端智能体',
    mode: 'iframe',
    requiresAuth: true,
    requiresCloud: true,
    urlSource: 'cloud-web',
    hidden: true,
  },
] as const

const testActions = [{ id: 'plugin-center.open', path: '/plugins' }] as const

const testSidebarNavigation = [
  {
    id: 'automations.navigation',
    activeItem: 'automation',
    icon: 'alarm-clock',
    labelKey: 'workbench.automation',
    label: '已安排',
    order: 10,
    path: '/automations',
    testId: 'automation-button',
  },
  {
    id: 'plugin-center.navigation',
    activeItem: 'plugins',
    icon: 'plug',
    labelKey: 'workbench.plugins',
    label: '插件',
    module: 'plugins/wework-ui-plugin-center-catalog.js',
    order: 20,
    path: '/plugins',
    prefetch: true,
    testId: 'plugins-button',
  },
  {
    id: 'applications.navigation',
    activeItem: 'sites',
    experimental: true,
    icon: 'applications',
    labelKey: 'workbench.sites',
    label: '应用',
    order: 30,
    path: '/sites',
    testId: 'sites-button',
  },
  {
    id: 'cloud-work.navigation',
    activeItem: 'cloud-work',
    labelKey: 'workbench.cloud_work_entry',
    label: '云端工作',
    module: 'plugins/wework-ui-cloud-work-sidebar.js',
    order: 40,
    path: '/cloud-work',
    surface: 'module',
  },
] as const

const settingsGroups = {
  personal: {
    category: 'personal',
    categoryLabelKey: 'settings_category_personal',
    categoryLabel: '个人',
  },
  integrations: {
    category: 'integrations',
    categoryLabelKey: 'settings_category_integrations',
    categoryLabel: '集成',
  },
  coding: {
    category: 'coding',
    categoryLabelKey: 'settings_category_coding',
    categoryLabel: '编码',
  },
  archived: {
    category: 'archived',
    categoryLabelKey: 'settings_category_archived',
    categoryLabel: '已归档',
  },
} as const

const testSettings = [
  ['general', '/settings', 'sliders-horizontal', 'settings_nav_general', '通用', 'personal'],
  [
    'connections',
    '/settings/connections',
    'globe-2',
    'settings_nav_connections',
    '云端连接',
    'personal',
  ],
  ['appearance', '/settings/appearance', 'palette', 'settings_nav_appearance', '外观', 'personal'],
  [
    'context',
    '/settings/personal/context',
    'terminal',
    'settings_nav_context',
    '上下文',
    'personal',
  ],
  [
    'model-settings',
    '/settings/personal/models',
    'user-round',
    'settings_nav_model_settings',
    '模型',
    'personal',
  ],
  ['proxy', '/settings/personal/proxy', 'network', 'settings_nav_proxy', '代理', 'personal'],
  [
    'keyboard-shortcuts',
    '/settings/personal/keyboard-shortcuts',
    'keyboard',
    'settings_nav_keyboard_shortcuts',
    '快捷键',
    'personal',
  ],
  [
    'quick-phrases',
    '/settings/personal/quick-phrases',
    'message-square-text',
    'settings_nav_quick_phrases',
    '快捷短语',
    'personal',
  ],
  [
    'runtimes',
    '/settings/personal/runtimes',
    'server',
    'settings_nav_runtimes',
    'Runtime',
    'personal',
  ],
  ['about', '/settings/about', 'info', 'settings_nav_about', '关于', 'personal'],
  [
    'appshots',
    '/settings/appshots',
    'scan-line',
    'settings_nav_appshots',
    '应用快照',
    'integrations',
  ],
  ['plugins', '/settings/plugins', 'package', 'settings_nav_plugins', '插件', 'integrations'],
  ['browser', '/settings/browser', 'app-window', 'settings_nav_browser', '浏览器', 'integrations'],
  [
    'git-hosting',
    '/settings/git-hosting',
    'git-pull-request',
    'settings_nav_git_hosting',
    '代码托管',
    'coding',
  ],
  [
    'execution-environments',
    '/settings/execution-environments',
    'cpu',
    'settings_nav_execution_environments',
    '执行环境',
    'coding',
  ],
  ['harnesses', '/settings/harnesses', 'code-2', 'settings_nav_harnesses', '编码工具', 'coding'],
  [
    'worktrees',
    '/settings/worktrees',
    'folder-git-2',
    'settings_nav_worktrees',
    '工作树',
    'coding',
  ],
  ['hooks', '/settings/hooks', 'webhook', 'settings_nav_hooks', 'Hooks', 'coding'],
  [
    'archived-conversations',
    '/settings/archived-conversations',
    'archive',
    'settings_nav_archived_conversations',
    '已归档对话',
    'archived',
  ],
].map(([id, path, icon, labelKey, label, group]) => ({
  id,
  module: 'plugins/wework-ui-core-settings.js',
  path,
  icon,
  labelKey,
  label,
  ...settingsGroups[group as keyof typeof settingsGroups],
  ...(id === 'model-settings' ? { aliases: ['/settings/personal'] } : {}),
  ...(id === 'browser' ? { aliases: ['/settings/browser/history'] } : {}),
  ...(id === 'keyboard-shortcuts' || id === 'appshots' ? { desktopOnly: true } : {}),
  ...(id === 'harnesses' ? { experimental: true } : {}),
}))

function installDefaultDshUiTestRuntime() {
  const entries = new Map<string, readonly WeworkDshSlotEntry[]>([
    [WEWORK_DSH_SLOTS.action, testActions],
    [WEWORK_DSH_SLOTS.app, testApps],
    [WEWORK_DSH_SLOTS.settingsPage, testSettings],
    [WEWORK_DSH_SLOTS.route, []],
    [WEWORK_DSH_SLOTS.sidebarNavigation, testSidebarNavigation],
    [WEWORK_DSH_SLOTS.shellAfter, []],
    [WEWORK_DSH_SLOTS.shellBefore, []],
    [WEWORK_DSH_SLOTS.shellOverlay, []],
    [WEWORK_DSH_SLOTS.workspaceSidebarTab, []],
    [WEWORK_DSH_SLOTS.workspaceTab, []],
  ])
  window.__WEWORK_DSH_UI__ = {
    getEntries: slotName => entries.get(slotName) ?? [],
    subscribe: () => () => {},
    attach: () => ({ update: () => {}, dispose: () => {} }),
  }
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' || input instanceof URL ? String(input) : input.url
}

async function defaultElectronHostFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (requestUrl(input) !== electronHostInvokePath) {
    return nativeFetch(input, init)
  }

  const request = JSON.parse(String(init?.body ?? '{}')) as {
    capability?: string
    params?: { patch?: Record<string, unknown> }
  }
  if (request.capability === 'preferences.get') {
    return Response.json({ ok: true, result: { ...testAppPreferences } })
  }
  if (request.capability === 'preferences.update') {
    testAppPreferences = {
      ...testAppPreferences,
      ...(request.params?.patch ?? {}),
    }
    return Response.json({ ok: true, result: { ...testAppPreferences } })
  }

  return nativeFetch(input, init)
}

globalThis.fetch = defaultElectronHostFetch

if (typeof window.ClipboardEvent === 'undefined') {
  window.ClipboardEvent = Event as unknown as typeof ClipboardEvent
}

const textPrototype = Text.prototype as Text & {
  getBoundingClientRect?: () => DOMRect
  getClientRects?: () => DOMRectList
}

if (typeof textPrototype.getBoundingClientRect === 'undefined') {
  textPrototype.getBoundingClientRect = () => new DOMRect()
}

if (typeof textPrototype.getClientRects === 'undefined') {
  textPrototype.getClientRects = () => [] as unknown as DOMRectList
}

const nodePrototype = Node.prototype as Node & {
  getBoundingClientRect?: () => DOMRect
}

if (typeof nodePrototype.getBoundingClientRect === 'undefined') {
  nodePrototype.getBoundingClientRect = () => new DOMRect()
}

if (typeof Range.prototype.getBoundingClientRect === 'undefined') {
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}

if (typeof Range.prototype.getClientRects === 'undefined') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

if (typeof document.elementFromPoint === 'undefined') {
  document.elementFromPoint = () => null
}

// BlockNote's side menu hit-tests pointer targets on mouse move.
if (typeof document.elementsFromPoint === 'undefined') {
  document.elementsFromPoint = () => []
}

// Mantine (via BlockNote) queries the preferred color scheme on mount.
if (typeof window.matchMedia === 'undefined') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

type StorageName = 'localStorage' | 'sessionStorage'

function hasStorageApi(value: unknown): value is Storage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Storage).getItem === 'function' &&
    typeof (value as Storage).setItem === 'function' &&
    typeof (value as Storage).removeItem === 'function' &&
    typeof (value as Storage).clear === 'function'
  )
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(String(key)) ?? null
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(String(key))
  }

  setItem(key: string, value: string) {
    this.values.set(String(key), String(value))
  }
}

function resolveTestStorage() {
  try {
    const localStorage = window.localStorage
    const sessionStorage = window.sessionStorage
    if (!hasStorageApi(localStorage) || !hasStorageApi(sessionStorage)) {
      throw new Error('Incomplete browser storage API')
    }
    return {
      constructor: window.Storage,
      localStorage,
      sessionStorage,
    }
  } catch {
    const localStorage = new MemoryStorage()
    const sessionStorage = new MemoryStorage()
    Object.defineProperties(window, {
      localStorage: { configurable: true, value: localStorage },
      sessionStorage: { configurable: true, value: sessionStorage },
    })
    return {
      constructor: MemoryStorage,
      localStorage,
      sessionStorage,
    }
  }
}

const testStorage = resolveTestStorage()

Object.defineProperty(globalThis, 'Storage', {
  configurable: true,
  value: testStorage.constructor,
  writable: true,
})

function installStorageGlobal(name: StorageName) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: testStorage[name],
    writable: true,
  })
}

installStorageGlobal('localStorage')
installStorageGlobal('sessionStorage')

beforeEach(() => {
  installDefaultDshUiTestRuntime()
  window.__WEWORK_DSH_UI_MODULES__ = {
    'plugins/wework-ui-cloud-work-sidebar.js': () =>
      import('../../dsh/ui-cloud-work/src/sidebar-navigation'),
    'plugins/wework-ui-core-settings.js': () =>
      import('../../dsh/ui-core-settings/src/settings-page'),
    'plugins/wework-ui-core-apps.js': () => import('../../dsh/ui-core-apps/src/app-surface'),
    'plugins/wework-ui-plugin-center-catalog.js': {
      default: () => null,
      preload: () => undefined,
    },
  }
  testAppPreferences = {}
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
  })
  window.__WEWORK_RUNTIME_CONFIG__ = {
    appBasePath: '',
    apiBaseUrl: '/api',
    socketBaseUrl: window.location.origin,
    socketPath: '/socket.io',
  }
  // Task-dialog drafts persist to localStorage; keep tests isolated.
  localStorage.clear()
})
