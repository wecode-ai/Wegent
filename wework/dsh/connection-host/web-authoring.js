import { randomUUID } from 'node:crypto'
import { ConnectionError } from '@wegent/dsh-plugin-runtime/connections'
import {
  createWebConnectionPackage,
  registerWebConnection,
  trialWebConnection,
} from '@wegent/dsh-plugin-runtime/web-connection-package'

export function createWebAuthoring(registry, desktop) {
  const drafts = new Map()

  function host() {
    const web = desktop()?.webConnections
    if (!web) throw new ConnectionError('connection_unavailable', 'A Wework desktop is required')
    return web
  }

  return Object.freeze({
    async trial({ label, captureId, definition, read, observation }, signal) {
      if (typeof label !== 'string' || !label || !definition)
        throw new ConnectionError('invalid_web_connection', 'Choose the website to connect')
      const name = `wework-web-${randomUUID()}`
      const prepared = createWebConnectionPackage({ name, version: '0.1.0', definition })
      const { providerId, definitionDigest, files } = prepared
      const binding = { providerId, definitionDigest }
      const { origin, pathPrefix, resource, operations } = definition
      const web = host()
      const trialId = await web.approveTrial(label, captureId, binding, {
        origin,
        pathPrefix,
        name: resource.name,
        account: resource.profile,
        operations: Object.values(operations).map(({ method, path }) => ({ method, path })),
      })
      const result = await trialWebConnection({
        definition,
        read,
        observation,
        signal,
        request: operation => web.read(binding, operation, trialId),
      })
      signal?.throwIfAborted()
      for (const [id, draft] of drafts) {
        if (Date.now() >= draft.expires) drafts.delete(id)
      }
      drafts.set(trialId, { binding, files, expires: Date.now() + 10 * 60_000 })
      return {
        trialId,
        providerId,
        observationWindow: observation,
        ...(definition.poll.minimum === undefined ? {} : { threshold: definition.poll.minimum }),
        ...result,
      }
    },
    async install({ trialId }) {
      const draft = drafts.get(trialId)
      if (!draft || draft.expires <= Date.now())
        throw new ConnectionError(
          'web_connection_trial_required',
          'Run the trial before installing'
        )
      if (draft.installing)
        throw new ConnectionError('web_connection_installing', 'The connection is being installed')
      draft.installing = true
      try {
        const installed = await host().install(draft.binding, trialId, draft.files)
        drafts.delete(trialId)
        return installed
      } finally {
        draft.installing = false
      }
    },
    register(owner, manifestUrl, content) {
      return registerWebConnection(registry, owner, manifestUrl, content, request =>
        host().read(
          { providerId: request.providerId, definitionDigest: request.definitionDigest },
          request.operation
        )
      )
    },
  })
}
