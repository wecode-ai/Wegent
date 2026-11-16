import { ExecutorRuntimeClient } from '@wegent/dsh-executor-runtime/client'
import { CoordinationRuntime } from './runtime.js'

export const name = 'wework-coordination-runtime'
export const inject = ['weworkPluginRuntime']

export async function apply(ctx) {
  const executor = ExecutorRuntimeClient.fromEnvironment()
  await executor.start()
  const runtime = new CoordinationRuntime(executor, {
    onError(error, contextId) {
      console.error('[wework-coordination] processing failed', {
        contextId,
        code: error.code ?? 'coordination_unavailable',
      })
    },
  })
  ctx.effect(
    () => () => {
      runtime.stop()
      void executor.stop()
    },
    'wework-coordination: lifecycle'
  )
  ctx.weworkPluginRuntime.register(ctx, {
    id: name,
    methods: {
      check: ({ contextId }) => runtime.check(contextId),
      status: ({ contextId }) => executor.request('runtime.coordination.status', { contextId }),
    },
  })
  await runtime.start()
}
