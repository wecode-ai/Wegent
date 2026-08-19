import type { Context, Plugin } from '@deepseek-ai/cordis'

import { PluginManagementPage } from '@/pages/PluginManagementPage'

export const harnessAppsPlugin: Plugin.Object<void> = {
  name: 'wework-harness-apps',
  inject: ['workbenchRoutes'],
  apply(ctx: Context) {
    return ctx.workbenchRoutes.register({
      id: 'harness-apps.management',
      path: '/plugins/manage/harness',
      telemetryFeature: 'plugins',
      render: () => <PluginManagementPage section="harness" />,
    })
  },
}
