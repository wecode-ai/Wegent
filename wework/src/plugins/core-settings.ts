import type { Context, Plugin } from '@deepseek-ai/cordis'

import { CORE_WORKBENCH_SETTINGS } from '@/plugin-runtime/core-settings-data'

export const coreSettingsPlugin: Plugin.Object<void> = {
  name: 'wework-core-settings',
  inject: ['workbenchSettings'],
  apply(ctx: Context) {
    const disposers = CORE_WORKBENCH_SETTINGS.map(contribution =>
      ctx.workbenchSettings.register(contribution)
    )
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  },
}
