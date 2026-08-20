import type { Context, Plugin } from '@deepseek-ai/cordis'

import { AutomationsPage } from '@/pages/AutomationsPage'

export const automationsPlugin: Plugin.Object<void> = {
  name: 'wework-automations',
  inject: ['workbenchRoutes'],
  apply(ctx: Context) {
    return ctx.workbenchRoutes.register({
      id: 'automations.root',
      path: '/automations',
      telemetryFeature: 'automations',
      render: () => <AutomationsPage />,
    })
  },
}
