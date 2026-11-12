import { listCodexComposerApps } from '@wegent/chat-core/codex-composer-catalog'
import type { LocalDeviceApp } from '@/types/api'

type Options = {
  includeInaccessible?: boolean
  forceRefetch?: boolean
  signal?: AbortSignal
}

interface PendingCatalog {
  scope: string
  forceRefetch: boolean
  controller: AbortController
  consumers: Set<symbol>
  promise: Promise<LocalDeviceApp[]>
}

/** Explicit authorization reads share pagination, but never retain account data after settling. */
export function createSharedCodexAppCatalog(
  request: (method: 'app/list', params: Record<string, unknown>) => Promise<unknown>
) {
  let pending: PendingCatalog | undefined

  const invalidate = () => {
    const previous = pending
    pending = undefined
    previous?.controller.abort()
  }

  const read = (scope: string, options: Options = {}): Promise<LocalDeviceApp[]> => {
    options.signal?.throwIfAborted()
    if (
      pending &&
      (pending.controller.signal.aborted ||
        pending.scope !== scope ||
        (options.forceRefetch && !pending.forceRefetch))
    )
      invalidate()

    if (!pending) {
      const controller = new AbortController()
      const entry: PendingCatalog = {
        scope,
        controller,
        forceRefetch: options.forceRefetch === true,
        consumers: new Set(),
        promise: Promise.resolve()
          .then(() =>
            listCodexComposerApps(request, {
              includeInaccessible: true,
              forceRefetch: options.forceRefetch,
              signal: controller.signal,
            })
          )
          .finally(() => {
            if (pending === entry) pending = undefined
          }),
      }
      pending = entry
    }
    return consume(pending, options)
  }

  return { read, invalidate }
}

function consume(entry: PendingCatalog, options: Options): Promise<LocalDeviceApp[]> {
  const consumer = Symbol('app-catalog')
  entry.consumers.add(consumer)
  return new Promise((resolve, reject) => {
    const detach = () => {
      options.signal?.removeEventListener('abort', cancel)
      entry.controller.signal.removeEventListener('abort', cancelShared)
      entry.consumers.delete(consumer)
    }
    const cancel = () => {
      detach()
      reject(options.signal?.reason)
      if (!entry.consumers.size) entry.controller.abort()
    }
    const cancelShared = () => {
      detach()
      reject(entry.controller.signal.reason)
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    entry.controller.signal.addEventListener('abort', cancelShared, { once: true })
    entry.promise.then(
      apps => {
        detach()
        resolve(apps.filter(app => options.includeInaccessible || app.isAccessible !== false))
      },
      error => {
        detach()
        reject(error)
      }
    )
  })
}
