import type { Context, Plugin } from '@deepseek-ai/cordis'
import { CORE_WORKBENCH_APPS } from '@/plugin-runtime/core-apps-data'

export const coreAppsPlugin: Plugin.Object<void> = {
  name: 'wework-core-apps',
  inject: ['workbenchApps'],
  apply(ctx: Context) {
    const disposers = CORE_WORKBENCH_APPS.map(app => ctx.workbenchApps.register(app))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  },
}
