import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { PluginWorkspaceConversationResult } from './PluginWorkspaceConversationResult'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, variables?: Record<string, string>) =>
      Object.entries(variables || {}).reduce(
        (value, [name, replacement]) => value.replace(`{{${name}}}`, replacement),
        fallback
      ),
  }),
}))

const { createDefaultPluginApi } = vi.hoisted(() => ({
  createDefaultPluginApi: vi.fn(),
}))

vi.mock('./workspace/marketplaceWorkspaceHelpers', () => ({
  createDefaultPluginApi,
}))

vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => ({
    apiBaseUrl: 'https://cloud.example/api',
    token: 'cloud-token',
  }),
}))

vi.mock('./PluginPublishDialog', () => ({
  PluginPublishDialog: ({
    pluginName,
    pluginVersion,
    onPublish,
  }: {
    pluginName: string
    pluginVersion: string
    onPublish: (request: unknown) => void
  }) => (
    <div>
      <span data-testid="mock-publish-version">{pluginName + ' v' + pluginVersion}</span>
      <button
        type="button"
        data-testid="mock-publish-confirm"
        onClick={() =>
          onPublish({
            visibility: 'personal',
            targets: [{ entityType: 'user', entityId: '7', displayName: 'Ada' }],
            allowCopy: true,
          })
        }
      >
        Confirm
      </button>
    </div>
  ),
}))

const resultMarker =
  '[WEGENT_PLUGIN_RESULT]{"schemaVersion":1,"taskId":"42","relativePath":"plugins/cloud-notes","name":"cloud-notes","displayName":"Cloud Notes","description":"Notes","version":"0.1.0","listingType":"skill","logo":"","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"ready"}'

describe('PluginWorkspaceConversationResult', () => {
  beforeEach(() => {
    createDefaultPluginApi.mockReset()
    createDefaultPluginApi.mockReturnValue({
      searchPluginShareUsers: vi.fn().mockResolvedValue({ users: [] }),
      searchPluginShareGroups: vi.fn().mockResolvedValue({ items: [] }),
    })
  })

  test('uses the active cloud connection for publication APIs', async () => {
    render(
      <PluginWorkspaceConversationResult
        taskId="42"
        messages={
          [
            {
              id: 'assistant-1',
              role: 'assistant',
              status: 'sent',
              content: resultMarker,
            },
          ] as WorkbenchMessage[]
        }
        waiting={false}
        onSendAction={vi.fn().mockResolvedValue(true)}
      />
    )

    await waitFor(() =>
      expect(createDefaultPluginApi).toHaveBeenCalledWith(
        'https://cloud.example/api',
        'cloud-token'
      )
    )
  })

  test('opens the restored manifest and sends publication back through the original Task', async () => {
    const onOpenFile = vi.fn()
    const onSendAction = vi.fn().mockResolvedValue(true)
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        status: 'sent',
        content: `Created.\n${resultMarker}`,
      },
    ] as WorkbenchMessage[]
    render(
      <PluginWorkspaceConversationResult
        taskId="42"
        workspacePath="/workspace/42"
        messages={messages}
        waiting={false}
        onOpenFile={onOpenFile}
        onSendAction={onSendAction}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-creator-view-plugin'))
    expect(onOpenFile).toHaveBeenCalledWith(
      '/workspace/42/plugins/cloud-notes/.codex-plugin/plugin.json'
    )

    fireEvent.click(screen.getByTestId('plugin-creator-publish-plugin'))
    await waitFor(() => expect(screen.getByTestId('mock-publish-version')).toBeInTheDocument())
    expect(screen.getByTestId('mock-publish-version')).toHaveTextContent('Cloud Notes v0.1.0')
    fireEvent.click(screen.getByTestId('mock-publish-confirm'))

    await waitFor(() => expect(onSendAction).toHaveBeenCalledOnce())
    const [visibleMessage, additionalContext] = onSendAction.mock.calls[0]
    expect(visibleMessage).toContain('Cloud Notes')
    expect(additionalContext.pluginCreatorPublish.kind).toBe('application')
    expect(additionalContext.pluginCreatorPublish.value).toContain(
      'plugin-workspace publish --plugin-root "$WEGENT_TASK_WORKSPACE/plugins/cloud-notes"'
    )
    const encoded = additionalContext.pluginCreatorPublish.value.match(
      /--request-base64 ([A-Za-z0-9+/=]+)/
    )?.[1]
    expect(JSON.parse(atob(encoded))).toEqual({
      visibility: 'personal',
      targets: [{ entityType: 'user', entityId: '7', displayName: 'Ada' }],
      allowCopy: true,
    })
  })
})
