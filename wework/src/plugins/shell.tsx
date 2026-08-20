import type { Context, Plugin } from '@deepseek-ai/cordis'

import { WorkbenchRootFrame } from './WorkbenchRootFrame'

export const shellPlugin: Plugin.Object<void> = {
  name: 'wework-shell',
  inject: ['workbenchSlots'],
  apply(ctx: Context) {
    return ctx.workbenchSlots.register({
      name: 'root',
      component: WorkbenchRootFrame,
      children: {
        'wework.shell.before': { kind: 'list', scope: 'root' },
        'wework.shell.after': { kind: 'list', scope: 'root' },
        'wework.shell.overlay': { kind: 'list', scope: 'root' },
      },
      registrant: 'wework-shell',
    })
  },
}
