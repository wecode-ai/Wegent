import type { Context, Plugin } from '@deepseek-ai/cordis'

import { CloudWorkPage } from '@/pages/CloudWorkPage'

export const cloudWorkPlugin: Plugin.Object<void> = {
  name: 'wework-cloud-work',
  inject: ['workbenchRoutes'],
  apply(ctx: Context) {
    return ctx.workbenchRoutes.register({
      id: 'cloud-work.root',
      path: '/cloud-work',
      telemetryFeature: 'cloud_work',
      render: () => <CloudWorkPage />,
    })
  },
}
