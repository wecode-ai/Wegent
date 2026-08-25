import {
  AppWindow,
  Archive,
  Code2,
  Cpu,
  FolderGit2,
  GitPullRequest,
  Globe2,
  Info,
  Keyboard,
  MessageSquareText,
  Network,
  Package,
  Palette,
  ScanLine,
  Server,
  SlidersHorizontal,
  Terminal,
  UserRound,
  Webhook,
} from 'lucide-react'

import { AppearanceSettingsPage } from '@/features/appearance/AppearanceSettingsPage'
import { HooksSettingsPage } from '@/features/hooks/HooksSettingsPage'
import { AboutSettingsPage } from '@/components/settings/AboutSettingsPage'
import { AppshotsSettingsPage } from '@/components/settings/AppshotsSettingsPage'
import { ArchivedConversationsSettingsPage } from '@/components/settings/ArchivedConversationsSettingsPage'
import { BrowserSettingsPage } from '@/components/settings/BrowserSettingsPage'
import { ContextSettingsPage } from '@/components/settings/ContextSettingsPage'
import { ExecutionEnvironmentsSettingsPage } from '@/components/settings/ExecutionEnvironmentsSettingsPage'
import { GeneralSettingsPage } from '@/components/settings/GeneralSettingsPage'
import { GitHostingSettingsPage } from '@/components/settings/GitHostingSettingsPage'
import { HarnessSettingsPage } from '@/components/settings/HarnessSettingsPage'
import { KeyboardShortcutsSettingsPage } from '@/components/settings/KeyboardShortcutsSettingsPage'
import { ModelSettingsPage } from '@/components/settings/ModelSettingsPage'
import { PluginSettingsPage } from '@/components/settings/PluginSettingsPage'
import { ProxySettingsPage } from '@/components/settings/ProxySettingsPage'
import { QuickPhrasesSettingsPage } from '@/components/settings/QuickPhrasesSettingsPage'
import { RuntimeSettingsPage } from '@/components/settings/RuntimeSettingsPage'
import { WorktreesSettingsPage } from '@/components/settings/WorktreesSettingsPage'

import type { WorkbenchSettingsContribution } from './settings'

const personal = {
  category: 'personal',
  categoryLabelKey: 'settings_category_personal',
  categoryLabel: '个人',
}
const integrations = {
  category: 'integrations',
  categoryLabelKey: 'settings_category_integrations',
  categoryLabel: '集成',
}
const coding = {
  category: 'coding',
  categoryLabelKey: 'settings_category_coding',
  categoryLabel: '编码',
}
const archived = {
  category: 'archived',
  categoryLabelKey: 'settings_category_archived',
  categoryLabel: '已归档',
}

export const CORE_WORKBENCH_SETTINGS = [
  {
    key: 'general',
    path: '/settings',
    icon: SlidersHorizontal,
    labelKey: 'settings_nav_general',
    label: '通用',
    ...personal,
    render: () => <GeneralSettingsPage />,
  },
  {
    key: 'connections',
    path: '/settings/connections',
    icon: Globe2,
    labelKey: 'settings_nav_connections',
    label: '云端连接',
    ...personal,
  },
  {
    key: 'appearance',
    path: '/settings/appearance',
    icon: Palette,
    labelKey: 'settings_nav_appearance',
    label: '外观',
    ...personal,
    render: () => <AppearanceSettingsPage />,
  },
  {
    key: 'context',
    path: '/settings/personal/context',
    icon: Terminal,
    labelKey: 'settings_nav_context',
    label: '上下文',
    ...personal,
    render: () => <ContextSettingsPage />,
  },
  {
    key: 'model-settings',
    path: '/settings/personal/models',
    aliases: ['/settings/personal'],
    icon: UserRound,
    labelKey: 'settings_nav_model_settings',
    label: '模型',
    ...personal,
    render: context => <ModelSettingsPage onOpenCloudSettings={context.onOpenCloudSettings} />,
  },
  {
    key: 'proxy',
    path: '/settings/personal/proxy',
    icon: Network,
    labelKey: 'settings_nav_proxy',
    label: '代理',
    ...personal,
    render: () => <ProxySettingsPage />,
  },
  {
    key: 'keyboard-shortcuts',
    path: '/settings/personal/keyboard-shortcuts',
    icon: Keyboard,
    labelKey: 'settings_nav_keyboard_shortcuts',
    label: '快捷键',
    desktopOnly: true,
    ...personal,
    render: () => <KeyboardShortcutsSettingsPage />,
  },
  {
    key: 'quick-phrases',
    path: '/settings/personal/quick-phrases',
    icon: MessageSquareText,
    labelKey: 'settings_nav_quick_phrases',
    label: '快捷短语',
    ...personal,
    render: () => <QuickPhrasesSettingsPage />,
  },
  {
    key: 'runtimes',
    path: '/settings/personal/runtimes',
    icon: Server,
    labelKey: 'settings_nav_runtimes',
    label: 'Runtime',
    ...personal,
    render: context => (
      <RuntimeSettingsPage
        runtimeProfileApi={context.services?.runtimeProfileApi}
        deliveryApi={context.services?.deliveryApi}
        deviceApi={context.services?.deviceApi}
        modelApi={context.services?.modelApi}
      />
    ),
  },
  {
    key: 'about',
    path: '/settings/about',
    icon: Info,
    labelKey: 'settings_nav_about',
    label: '关于',
    ...personal,
    render: () => <AboutSettingsPage />,
  },
  {
    key: 'appshots',
    path: '/settings/appshots',
    icon: ScanLine,
    labelKey: 'settings_nav_appshots',
    label: '应用快照',
    desktopOnly: true,
    ...integrations,
    render: () => <AppshotsSettingsPage />,
  },
  {
    key: 'plugins',
    path: '/settings/plugins',
    icon: Package,
    labelKey: 'settings_nav_plugins',
    label: '插件',
    ...integrations,
    render: () => <PluginSettingsPage />,
  },
  {
    key: 'browser',
    path: '/settings/browser',
    aliases: ['/settings/browser/history'],
    icon: AppWindow,
    labelKey: 'settings_nav_browser',
    label: '浏览器',
    ...integrations,
    render: () => <BrowserSettingsPage />,
  },
  {
    key: 'git-hosting',
    path: '/settings/git-hosting',
    icon: GitPullRequest,
    labelKey: 'settings_nav_git_hosting',
    label: '代码托管',
    ...coding,
    render: () => <GitHostingSettingsPage />,
  },
  {
    key: 'execution-environments',
    path: '/settings/execution-environments',
    icon: Cpu,
    labelKey: 'settings_nav_execution_environments',
    label: '执行环境',
    ...coding,
    render: () => <ExecutionEnvironmentsSettingsPage />,
  },
  {
    key: 'harnesses',
    path: '/settings/harnesses',
    icon: Code2,
    labelKey: 'settings_nav_harnesses',
    label: '编码工具',
    experimental: true,
    ...coding,
    render: () => <HarnessSettingsPage />,
  },
  {
    key: 'worktrees',
    path: '/settings/worktrees',
    icon: FolderGit2,
    labelKey: 'settings_nav_worktrees',
    label: '工作树',
    ...coding,
    render: context => (
      <WorktreesSettingsPage
        api={context.services?.runtimeWorkApi}
        devices={context.devices}
        onOpenRuntimeTask={context.onOpenRuntimeTask}
        onRefreshWorkLists={context.onRefreshWorkLists}
        onLeaveSettings={context.onBack}
      />
    ),
  },
  {
    key: 'hooks',
    path: '/settings/hooks',
    icon: Webhook,
    labelKey: 'settings_nav_hooks',
    label: 'Hooks',
    ...coding,
    render: () => <HooksSettingsPage />,
  },
  {
    key: 'archived-conversations',
    path: '/settings/archived-conversations',
    icon: Archive,
    labelKey: 'settings_nav_archived_conversations',
    label: '已归档对话',
    ...archived,
    render: context => (
      <ArchivedConversationsSettingsPage
        api={context.services?.runtimeWorkApi}
        onOpenRuntimeTask={context.onOpenRuntimeTask}
        onRefreshWorkLists={context.onRefreshWorkLists}
        onLeaveSettings={context.onBack}
      />
    ),
  },
] as const satisfies readonly WorkbenchSettingsContribution[]
