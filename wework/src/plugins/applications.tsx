import type { Context, Plugin } from '@deepseek-ai/cordis'

import { SitesPage } from '@/pages/SitesPage'

export const applicationsPlugin: Plugin.Object<void> = {
  name: 'wework-applications',
  inject: ['workbenchRoutes'],
  apply(ctx: Context) {
    return ctx.workbenchRoutes.register({
      id: 'applications.sites',
      path: '/sites',
      telemetryFeature: 'sites',
      render: () => <SitesPage />,
    })
  },
}
