import { useCallback, useMemo, useState } from 'react'
import { createDefaultPluginApi } from './workspace/marketplaceWorkspaceHelpers'
import { PluginCreatorResultCard } from './PluginCreatorResultCard'
import { PluginPublishDialog, type PluginPublishRequest } from './PluginPublishDialog'
import { latestPluginWorkspaceResult, pluginWorkspaceManifestPath } from './pluginWorkspaceResult'
import type { RuntimeAdditionalContext } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { useTranslation } from '@/hooks/useTranslation'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'

interface PluginWorkspaceConversationResultProps {
  taskId?: string | null
  workspacePath?: string | null
  messages: WorkbenchMessage[]
  waiting: boolean
  onOpenFile?: (path: string) => void
  onSendAction: (message: string, additionalContext: RuntimeAdditionalContext) => Promise<boolean>
}

function encodeBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

export function PluginWorkspaceConversationResult({
  taskId,
  workspacePath,
  messages,
  waiting,
  onOpenFile,
  onSendAction,
}: PluginWorkspaceConversationResultProps) {
  const { t } = useTranslation('common')
  const result = useMemo(() => latestPluginWorkspaceResult(messages, taskId), [messages, taskId])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cloudConnection = useOptionalCloudConnection()
  const pluginApi = useMemo(
    () => createDefaultPluginApi(cloudConnection.apiBaseUrl, cloudConnection.token),
    [cloudConnection.apiBaseUrl, cloudConnection.token]
  )

  const searchUsers = useCallback(
    async (query: string) => (await pluginApi.searchPluginShareUsers(query)).users,
    [pluginApi]
  )
  const searchGroups = useCallback(
    async (query: string) => (await pluginApi.searchPluginShareGroups(query)).items,
    [pluginApi]
  )

  if (!result) return null
  const published = result.status === 'published' || result.status === 'pending_review'
  const statusLabel =
    result.status === 'published'
      ? t('workbench.plugins_creator_published_status', '已发布')
      : result.status === 'pending_review'
        ? t('workbench.plugins_creator_pending_review_status', '已提交审核')
        : t('workbench.plugins_creator_workspace_status', '已保存在当前对话工作区')

  const submit = async (request: PluginPublishRequest) => {
    if (publishing) return
    setPublishing(true)
    setError(null)
    const encodedRequest = encodeBase64(request)
    const command = [
      '"$WEGENT_EXECUTOR_BINARY"',
      'plugin-workspace publish',
      `--plugin-root "$WEGENT_TASK_WORKSPACE/${result.relativePath}"`,
      `--listing-type ${result.listingType}`,
      `--request-base64 ${encodedRequest}`,
    ].join(' ')
    const visibleMessage = t(
      'workbench.plugins_creator_publish_message',
      '发布 Plugin Creator 创建的“{{name}}”',
      { name: result.displayName || result.name }
    )
    const sent = await onSendAction(visibleMessage, {
      pluginCreatorPublish: {
        kind: 'application',
        value: [
          'The user approved publishing the Plugin Creator result from this Task workspace.',
          `Run this exact command: ${command}`,
          'Do not rebuild the plugin elsewhere. The command revalidates, packages, uploads, scans, and submits the current workspace source.',
          'After it succeeds, include its complete [WEGENT_PLUGIN_RESULT] line verbatim on its own line in your final response.',
        ].join('\n'),
      },
    })
    if (sent) {
      setDialogOpen(false)
    } else {
      setError(t('workbench.plugins_creator_publish_send_failed', '发布请求发送失败，请重试。'))
    }
    setPublishing(false)
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-4" data-testid="plugin-workspace-result">
      <PluginCreatorResultCard
        name={result.displayName || result.name}
        description={result.description}
        logoUrl={result.logo}
        validationSummary={`v${result.version}`}
        statusLabel={statusLabel}
        onViewPlugin={() => {
          const manifestPath = pluginWorkspaceManifestPath(workspacePath, result)
          if (onOpenFile) {
            onOpenFile(manifestPath)
            return
          }
          void onSendAction(
            t('workbench.plugins_creator_view_message', '查看“{{name}}”的插件文件', {
              name: result.displayName || result.name,
            }),
            {
              pluginCreatorView: {
                kind: 'application',
                value: `Inspect the Plugin Creator source at $WEGENT_TASK_WORKSPACE/${result.relativePath}.`,
              },
            }
          )
        }}
        onPublish={!published && !waiting ? () => setDialogOpen(true) : undefined}
      />
      {dialogOpen ? (
        <PluginPublishDialog
          pluginName={result.displayName || result.name}
          pluginVersion={result.version}
          publishing={publishing}
          error={error}
          onClose={() => {
            if (!publishing) setDialogOpen(false)
          }}
          onPublish={request => void submit(request)}
          searchUsers={searchUsers}
          searchGroups={searchGroups}
        />
      ) : null}
    </div>
  )
}
