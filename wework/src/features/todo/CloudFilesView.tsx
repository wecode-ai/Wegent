import { useCallback, useId, useMemo, type ReactNode } from 'react'
import { reportE2EDiagnostic } from '@/e2e/error-capture'
import {
  CollaborationFilesView,
  createCollaborationTranslator,
  createSharedWorkspaceFilesViewApi,
  type CollaborationFilePreviewProps,
  type CollaborationFilesTranslateOptions,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { CloudProject } from '@/api/deliveries'
import { WorkspaceFilePreview } from '@/components/layout/workspace-panels/WorkspaceFilePreview'
import { Tooltip } from '@/components/ui/tooltip'
import { createWeworkDeliverySharedWorkspaceApi } from '@/features/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { track } from '@/telemetry/client'
import type { WorkspaceTextFileResponse } from '@/types/workspace-files'
import { readFileFromAccessUrl, saveBlobToDownloads } from './cloudFileTransfer'

const fileApiIdentities = new WeakMap<object, number>()
let nextFileApiIdentity = 0

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>
type CloudFilesWorkspaceApi = Pick<SharedWorkspaceApi, 'files' | 'attachments'>

function WeworkFilePreview({
  file,
  binaryFile,
  loading,
  error,
  onRetry,
}: CollaborationFilePreviewProps) {
  return (
    <WorkspaceFilePreview
      file={file as WorkspaceTextFileResponse | null}
      binaryFile={binaryFile}
      loading={loading}
      error={error}
      onRetry={onRetry}
      onAddCodeComment={() => undefined}
    />
  )
}

const telemetry = {
  completed(action: 'upload' | 'create' | 'preview' | 'download' | 'open' | 'delete' | 'move') {
    track('feature_action_completed', { action, domain: 'project_space_file' })
  },
  failed() {
    track('operation_failed', { operation: 'project_space_file_action' })
  },
}

function WeworkFilesView({
  workspaceApi,
  project,
}: {
  workspaceApi: CloudFilesWorkspaceApi
  project: CloudProject
}) {
  const instanceId = useId()
  const { i18n, t } = useTranslation('common')
  const language = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const sharedTranslate = useMemo(
    () => createCollaborationTranslator(language.startsWith('en') ? 'en' : 'zh-CN'),
    [language]
  )
  useMemo(() => {
    let apiId = fileApiIdentities.get(workspaceApi)
    if (apiId === undefined) {
      apiId = ++nextFileApiIdentity
      fileApiIdentities.set(workspaceApi, apiId)
    }
    reportE2EDiagnostic('project-files-scope', {
      instanceId,
      apiId,
      projectId: String(project.id),
      projectStore: project.project_store,
    })
  }, [instanceId, workspaceApi, project.id, project.project_store])
  const filesApi = useMemo(
    () =>
      createSharedWorkspaceFilesViewApi(
        {
          files: workspaceApi.files,
          attachments: workspaceApi.attachments,
        },
        {
          readAccess: access => readFileFromAccessUrl(access.url),
          saveTaskAttachment: saveBlobToDownloads,
        }
      ),
    [workspaceApi]
  )
  const translate = useCallback(
    (key: string, fallback?: string, options?: CollaborationFilesTranslateOptions) => {
      const translated = fallback === undefined ? t(key, options) : t(key, fallback, options)
      return typeof translated === 'string' && translated !== key
        ? translated
        : sharedTranslate(key, fallback, options)
    },
    [sharedTranslate, t]
  )
  const renderTooltip = useCallback(
    (label: string, child: ReactNode, align: 'start' | 'center' | 'end' = 'center') => (
      <Tooltip label={label} align={align}>
        {child}
      </Tooltip>
    ),
    []
  )

  return (
    <CollaborationFilesView
      api={filesApi}
      project={project}
      PreviewComponent={WeworkFilePreview}
      saveDownload={saveBlobToDownloads}
      telemetry={telemetry}
      t={translate}
      renderTooltip={renderTooltip}
    />
  )
}

export function CloudFilesView({
  api,
  project,
}: {
  api: CloudFilesWorkspaceApi
  project: CloudProject
}) {
  return <WeworkFilesView workspaceApi={api} project={project} />
}

export function LocalFilesView({ api, project }: { api: DeliveryApi; project: CloudProject }) {
  const workspaceApi = useMemo(() => createWeworkDeliverySharedWorkspaceApi(api), [api])
  return <WeworkFilesView workspaceApi={workspaceApi} project={project} />
}
