import type {
  InstalledPlugin,
  InstalledPluginListResponse,
  InstalledPluginUpdateRequest,
  PluginAccessResponse,
  PluginAccessUpdateRequest,
  PluginAutoUpdateBatchResponse,
  PluginCopyResponse,
  PluginDeleteImpactResponse,
  PluginDeleteRequest,
  PluginDeleteResponse,
  PluginDeviceReportItem,
  PluginDeviceReportResponse,
  PluginDeviceSyncResponse,
  PluginMarketplaceInstallResponse,
  PluginMarketplaceListResponse,
  PluginPublicationCreateRequest,
  PluginPublicationInitResponse,
  PluginPublicationRequestItem,
  PluginPublicationRequestListResponse,
  PluginSubmissionCompleteResponse,
  PluginSubmissionInitRequest,
  PluginSubmissionInitResponse,
} from '@/types/api'
import { sha256Hex } from './fileHash'
import type { HttpClient } from './http'
import { resolveApiUrl } from './resolveApiUrl'

export interface PluginShareUserSearchItem {
  id: number
  user_name: string
  email?: string | null
}

export interface PluginShareGroupSearchItem {
  id: number
  name: string
  display_name?: string | null
}

function idempotencyOptions(key: string) {
  return { headers: { 'Idempotency-Key': key } }
}

function publicationPayloadFingerprint(payload: object): string {
  const serialized = JSON.stringify(payload)
  let first = 2166136261
  let second = 2246822507
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 3266489917)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}${serialized.length.toString(16)}`
}

async function uploadPublicationSnapshot(
  client: HttpClient,
  file: File,
  initialize: (snapshot: {
    filename: string
    snapshotSha256: string
    sizeBytes: number
  }) => Promise<PluginPublicationInitResponse>,
  onUploadFailure?: (initialized: PluginPublicationInitResponse) => Promise<unknown>
): Promise<PluginPublicationRequestItem> {
  const snapshotSha256 = await sha256Hex(file)
  const initialized = await initialize({
    filename: file.name,
    snapshotSha256,
    sizeBytes: file.size,
  })
  const revision = initialized.revision.number
  try {
    const upload = await globalThis.fetch(initialized.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    })
    if (!upload.ok) {
      throw new Error('Plugin upload failed with HTTP ' + upload.status)
    }
    return await client.post<PluginPublicationRequestItem>(
      '/plugins/publication-requests/' +
        initialized.requestId +
        '/revisions/' +
        revision +
        '/complete',
      undefined,
      idempotencyOptions(
        `plugin-publication-complete-${initialized.requestId}-r${revision}-${snapshotSha256}`
      )
    )
  } catch (error) {
    await onUploadFailure?.(initialized).catch(() => undefined)
    throw error
  }
}

export function createPluginApi(client: HttpClient, apiBaseUrl = '') {
  const deviceQuery = (deviceId?: string) => {
    const normalized = deviceId?.trim()
    return normalized ? `?device_id=${encodeURIComponent(normalized)}` : ''
  }
  const initSubmission = async (
    data: PluginSubmissionInitRequest
  ): Promise<PluginSubmissionInitResponse> => {
    const initialized = await client.post<PluginSubmissionInitResponse>(
      '/plugins/submissions/init',
      data
    )
    return {
      ...initialized,
      uploadUrl: resolveApiUrl(initialized.uploadUrl, apiBaseUrl),
    }
  }

  return {
    listInstalledPlugins(deviceId?: string): Promise<InstalledPluginListResponse> {
      return client.get(`/plugins/installed${deviceQuery(deviceId)}`)
    },
    syncInstalledPluginsToDevice(deviceId: string): Promise<PluginDeviceSyncResponse> {
      return client.post(`/plugins/installed/sync-device${deviceQuery(deviceId)}`)
    },
    reportInstalledPluginsOnDevice(
      deviceId: string,
      plugins: PluginDeviceReportItem[]
    ): Promise<PluginDeviceReportResponse> {
      return client.post(`/plugins/installed/report-device${deviceQuery(deviceId)}`, {
        plugins,
      })
    },
    autoUpdateInstalledPlugins(): Promise<PluginAutoUpdateBatchResponse> {
      return client.post('/plugins/installed/auto-update-batch')
    },
    updateInstalledPlugin(
      id: string | number,
      data: InstalledPluginUpdateRequest,
      deviceId?: string
    ): Promise<InstalledPlugin> {
      return client.put(`/plugins/installed/${id}${deviceQuery(deviceId)}`, data)
    },
    uninstallInstalledPlugin(id: string | number, deviceId?: string): Promise<void> {
      return client.delete(`/plugins/installed/${id}${deviceQuery(deviceId)}`)
    },
    listMarketplacePlugins(
      params: { q?: string; source?: string; deviceId?: string } = {}
    ): Promise<PluginMarketplaceListResponse> {
      const query = new URLSearchParams()
      if (params.q?.trim()) query.set('q', params.q.trim())
      if (params.source) query.set('source', params.source)
      if (params.deviceId?.trim()) query.set('device_id', params.deviceId.trim())
      const suffix = query.toString() ? `?${query.toString()}` : ''
      return client.get(`/plugins/marketplace${suffix}`)
    },
    installMarketplacePlugin(
      id: string | number,
      deviceId?: string
    ): Promise<PluginMarketplaceInstallResponse> {
      return client.post(`/plugins/marketplace/${id}/install${deviceQuery(deviceId)}`)
    },
    updateMarketplacePlugin(
      installedId: string | number,
      releaseId: number,
      deviceId?: string
    ): Promise<InstalledPlugin> {
      return client.put(`/plugins/installed/${installedId}${deviceQuery(deviceId)}`, { releaseId })
    },
    getMarketplacePluginAccess(id: string | number): Promise<PluginAccessResponse> {
      return client.get(`/plugins/marketplace/${id}/access`)
    },
    updateMarketplacePluginAccess(
      id: string | number,
      data: PluginAccessUpdateRequest
    ): Promise<PluginAccessResponse> {
      return client.put(`/plugins/marketplace/${id}/access`, data)
    },
    getMarketplacePluginDeleteImpact(id: string | number): Promise<PluginDeleteImpactResponse> {
      return client.get(`/plugins/marketplace/${id}/delete-impact`)
    },
    deleteMarketplacePlugin(
      id: string | number,
      data: PluginDeleteRequest
    ): Promise<PluginDeleteResponse> {
      return client.delete(`/plugins/marketplace/${id}`, data)
    },
    copyMarketplacePlugin(id: string | number): Promise<PluginCopyResponse> {
      return client.post(`/plugins/marketplace/${id}/copy`)
    },
    searchPluginShareUsers(
      query: string
    ): Promise<{ users: PluginShareUserSearchItem[]; total: number }> {
      return client.get(`/users/search?q=${encodeURIComponent(query)}&limit=20`)
    },
    searchPluginShareGroups(
      query: string
    ): Promise<{ items: PluginShareGroupSearchItem[]; total: number }> {
      return client.get(
        `/groups/search?q=${encodeURIComponent(query)}&limit=20&include_organization=true`
      )
    },
    listPublicationRequests(
      params: { sourcePluginId?: number; activeOnly?: boolean; page?: number; limit?: number } = {}
    ): Promise<PluginPublicationRequestListResponse> {
      const query = new URLSearchParams()
      if (params.sourcePluginId) query.set('sourcePluginId', String(params.sourcePluginId))
      if (params.activeOnly !== undefined) query.set('activeOnly', String(params.activeOnly))
      if (params.page) query.set('page', String(params.page))
      if (params.limit) query.set('limit', String(params.limit))
      const suffix = query.toString() ? '?' + query.toString() : ''
      return client.get('/plugins/publication-requests' + suffix)
    },
    getPublicationRequest(id: number, revision?: number): Promise<PluginPublicationRequestItem> {
      const suffix = revision === undefined ? '' : '?revision=' + encodeURIComponent(revision)
      return client.get('/plugins/publication-requests/' + id + suffix)
    },
    initSubmission,
    completeSubmission(id: number): Promise<PluginSubmissionCompleteResponse> {
      return client.post(`/plugins/submissions/${id}/complete`)
    },
    withdrawPublicationRequest(
      id: number,
      currentRevision: number
    ): Promise<PluginPublicationRequestItem> {
      return client.post(
        '/plugins/publication-requests/' + id + '/withdraw',
        undefined,
        idempotencyOptions(`plugin-publication-withdraw-${id}-r${currentRevision}`)
      )
    },
    async publishPublicationRequest(
      file: File,
      metadata: Omit<PluginPublicationCreateRequest, 'filename' | 'snapshotSha256' | 'sizeBytes'>,
      operationAttemptId: string
    ): Promise<PluginPublicationRequestItem> {
      return uploadPublicationSnapshot(
        client,
        file,
        snapshot => {
          const payload = {
            ...metadata,
            ...snapshot,
          }
          return client.post<PluginPublicationInitResponse>(
            '/plugins/publication-requests',
            payload,
            idempotencyOptions(
              `plugin-publication-create-${operationAttemptId}-${publicationPayloadFingerprint(payload)}`
            )
          )
        },
        initialized =>
          client.post(
            '/plugins/publication-requests/' + initialized.requestId + '/withdraw',
            undefined,
            idempotencyOptions(
              `plugin-publication-withdraw-${initialized.requestId}-r${initialized.revision.number}`
            )
          )
      )
    },
    publishPublicationRevision(
      requestId: number,
      file: File,
      metadata: Omit<
        PluginPublicationCreateRequest,
        | 'sourcePluginId'
        | 'slug'
        | 'displayName'
        | 'listingType'
        | 'filename'
        | 'snapshotSha256'
        | 'sizeBytes'
      >,
      operationAttemptId: string
    ): Promise<PluginPublicationRequestItem> {
      return uploadPublicationSnapshot(
        client,
        file,
        snapshot => {
          const payload = {
            ...metadata,
            ...snapshot,
          }
          return client.post<PluginPublicationInitResponse>(
            '/plugins/publication-requests/' + requestId + '/revisions',
            payload,
            idempotencyOptions(
              `plugin-publication-revision-${requestId}-${operationAttemptId}-${publicationPayloadFingerprint(payload)}`
            )
          )
        },
        initialized =>
          client.post(
            '/plugins/publication-requests/' + initialized.requestId + '/withdraw',
            undefined,
            idempotencyOptions(
              `plugin-publication-withdraw-${initialized.requestId}-r${initialized.revision.number}`
            )
          )
      )
    },
    ensureBuiltinPluginInstalled(
      pluginKey: string,
      options: { deviceId?: string } = {}
    ): Promise<PluginMarketplaceInstallResponse> {
      return client.post(`/plugins/builtin/${encodeURIComponent(pluginKey)}/ensure-installed`, {
        ...(options.deviceId ? { device_id: options.deviceId } : {}),
      })
    },
    async publishSubmission(
      file: File,
      metadata: Pick<
        PluginSubmissionInitRequest,
        | 'slug'
        | 'displayName'
        | 'version'
        | 'listingType'
        | 'purpose'
        | 'visibility'
        | 'targets'
        | 'allowCopy'
      >
    ): Promise<PluginSubmissionCompleteResponse> {
      const sha256 = await sha256Hex(file)
      const initialized = await initSubmission({
        ...metadata,
        filename: file.name,
        sha256,
        sizeBytes: file.size,
      })
      try {
        const uploadTransport = globalThis.fetch.bind(globalThis)
        const upload = await uploadTransport(initialized.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/zip' },
          body: file,
        })
        if (!upload.ok) throw new Error(`Plugin upload failed with HTTP ${upload.status}`)
        return await client.post<PluginSubmissionCompleteResponse>(
          `/plugins/submissions/${initialized.submissionId}/complete`
        )
      } catch (error) {
        await client
          .post(`/plugins/submissions/${initialized.submissionId}/cancel`)
          .catch(() => undefined)
        throw error
      }
    },
  }
}
