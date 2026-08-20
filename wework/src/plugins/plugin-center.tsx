import type { Context, Plugin } from '@deepseek-ai/cordis'

import { PluginCreatePage } from '@/pages/PluginCreatePage'
import { PluginManagementPage } from '@/pages/PluginManagementPage'
import { PluginsPage } from '@/pages/PluginsPage'

export const pluginCenterPlugin: Plugin.Object<void> = {
  name: 'wework-plugin-center',
  inject: ['workbenchRoutes'],
  apply(ctx: Context) {
    const disposers = [
      ctx.workbenchRoutes.register({
        id: 'plugin-center.catalog',
        path: '/plugins',
        telemetryFeature: 'plugins',
        render: ({ search }) => <PluginsPage routeSearch={search} />,
      }),
      ctx.workbenchRoutes.register({
        id: 'plugin-center.create',
        path: '/plugins/create',
        telemetryFeature: 'plugin_create',
        render: () => <PluginCreatePage />,
      }),
      ctx.workbenchRoutes.register({
        id: 'plugin-center.management',
        path: '/plugins/manage',
        telemetryFeature: 'plugin_management',
        render: () => <PluginManagementPage />,
      }),
    ]
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  },
}
