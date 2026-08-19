import type { Context, Plugin } from '@deepseek-ai/cordis'

import { HarnessAppsPage } from '@/pages/HarnessAppsPage'

export const harnessAppsPlugin: Plugin.Object<void> = {
  name: 'wework-harness-apps',
  inject: ['workbenchRoutes'],
  apply(ctx: Context) {
    return ctx.workbenchRoutes.register({
      id: 'harness-apps.management',
      path: '/harness-apps',
      telemetryFeature: 'plugins',
      render: () => <HarnessAppsPage />,
    })
  },
}
