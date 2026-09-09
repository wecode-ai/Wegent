import { AppearanceSettingsPage } from '@/features/appearance/AppearanceSettingsPage'
import { HooksSettingsPage } from '@/features/hooks/HooksSettingsPage'
import { AboutSettingsPage } from '@/components/settings/AboutSettingsPage'
import { AppshotsSettingsPage } from '@/components/settings/AppshotsSettingsPage'
import { ArchivedConversationsSettingsPage } from '@/components/settings/ArchivedConversationsSettingsPage'
import { BrowserSettingsPage } from '@/components/settings/BrowserSettingsPage'
import { ConnectionsDeviceSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { ComputerUseSettingsPage } from '@/components/settings/ComputerUseSettingsPage'
import { ContextSettingsPage } from '@/components/settings/ContextSettingsPage'
import { ExecutionEnvironmentsSettingsPage } from '@/components/settings/ExecutionEnvironmentsSettingsPage'
import { GeneralSettingsPage } from '@/components/settings/GeneralSettingsPage'
import { HarnessSettingsPage } from '@/components/settings/HarnessSettingsPage'
import { KeyboardShortcutsSettingsPage } from '@/components/settings/KeyboardShortcutsSettingsPage'
import { ModelSettingsPage } from '@/components/settings/ModelSettingsPage'
import { PluginSettingsPage } from '@/components/settings/PluginSettingsPage'
import { ProxySettingsPage } from '@/components/settings/ProxySettingsPage'
import { QuickPhrasesSettingsPage } from '@/components/settings/QuickPhrasesSettingsPage'
import { RuntimeSettingsPage } from '@/components/settings/RuntimeSettingsPage'
import type { WeworkDshSettingsModuleProps } from '@/features/dsh-runtime/DshSettingsSurface'

export default function CoreSettingsPage({
  page,
  services,
  onBack,
  onOpenCloudSettings,
  onOpenRuntimeTask,
  onRefreshWorkLists,
  autoOpenAddCloudDeviceDialog,
}: WeworkDshSettingsModuleProps) {
  switch (page.id) {
    case 'about':
      return <AboutSettingsPage />
    case 'appearance':
      return <AppearanceSettingsPage />
    case 'appshots':
      return <AppshotsSettingsPage />
    case 'archived-conversations':
      return (
        <ArchivedConversationsSettingsPage
          api={services?.runtimeWorkApi}
          onOpenRuntimeTask={onOpenRuntimeTask}
          onRefreshWorkLists={onRefreshWorkLists}
          onLeaveSettings={onBack}
        />
      )
    case 'browser':
      return <BrowserSettingsPage />
    case 'connections':
      return (
        <ConnectionsDeviceSettingsPage
          autoOpenAddCloudDeviceDialog={Boolean(autoOpenAddCloudDeviceDialog)}
        />
      )
    case 'computer-use':
      return <ComputerUseSettingsPage />
    case 'context':
      return <ContextSettingsPage />
    case 'execution-environments':
      return <ExecutionEnvironmentsSettingsPage />
    case 'general':
      return <GeneralSettingsPage />
    case 'harnesses':
      return <HarnessSettingsPage />
    case 'hooks':
      return <HooksSettingsPage />
    case 'keyboard-shortcuts':
      return <KeyboardShortcutsSettingsPage />
    case 'model-settings':
      return <ModelSettingsPage onOpenCloudSettings={onOpenCloudSettings} />
    case 'plugins':
      return <PluginSettingsPage />
    case 'proxy':
      return <ProxySettingsPage />
    case 'quick-phrases':
      return <QuickPhrasesSettingsPage />
    case 'runtimes':
      return (
        <RuntimeSettingsPage
          runtimeProfileApi={services?.runtimeProfileApi}
          deliveryApi={services?.deliveryApi}
          deviceApi={services?.deviceApi}
          modelApi={services?.modelApi}
        />
      )
    default:
      throw new Error(`Unknown core settings page: ${page.id}`)
  }
}
