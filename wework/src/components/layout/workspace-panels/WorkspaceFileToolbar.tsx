import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { ActionMenu, type ActionMenuItem, type MenuPosition } from '@/components/common/ActionMenu'
import { useLocalWorkspaceOpeners } from '@/hooks/useLocalWorkspaceOpeners'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { fileManagerRevealLabel } from '@/lib/file-manager'
import { isLocalTerminalAvailable, openLocalFile, revealLocalFile } from '@/lib/local-terminal'
import {
  prioritizeWorkspaceOpener,
  type LocalWorkspaceOpenerId,
} from '@/lib/local-workspace-openers'
import { normalizeWorkspaceSeparators } from '@/lib/workspace-file-contract'
import {
  resolveWorkspaceOpener,
  setPreferredWorkspaceOpener,
  usePreferredWorkspaceOpener,
} from '@/lib/workspace-opener-preferences'
import type { WorkspaceFileApi, WorkspaceFileEntry, WorkspaceTarget } from '@/types/workspace-files'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ChevronDown, FileOutput, Folder, Loader2, X } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { LocalWorkspaceOpenerIcon } from './LocalWorkspaceOpenerMenu'
import { WorkspaceFileBreadcrumbs } from './WorkspaceFileBreadcrumbs'
import { workspaceFilePreviewKind } from './workspaceFileTypes'

interface WorkspaceFileToolbarProps {
  path: string
  isDirectory: boolean
  target: WorkspaceTarget
  api: WorkspaceFileApi
  textContent?: string
  canCopyContents: boolean
  onSelect: (entry: WorkspaceFileEntry) => void
  children: ReactNode
}

interface HostedFileTarget {
  provider: 'git' | 'github' | 'gitlab'
  url: string
}

function normalizeHostedFileTarget(value: unknown): HostedFileTarget | null {
  if (typeof value === 'string' && value) return { provider: 'github', url: value }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    (record.provider === 'git' || record.provider === 'github' || record.provider === 'gitlab') &&
    typeof record.url === 'string' &&
    record.url
  ) {
    return { provider: record.provider, url: record.url }
  }
  return null
}

export function WorkspaceFileRootSelector({
  targets,
  target,
  onSelect,
}: {
  targets: WorkspaceTarget[]
  target: WorkspaceTarget
  onSelect: (target: WorkspaceTarget) => void
}) {
  const { t } = useTranslation('common')
  const unique = targets.filter(
    (candidate, index) =>
      targets.findIndex(
        item => item.deviceId === candidate.deviceId && item.path === candidate.path
      ) === index
  )
  if (unique.length < 2) return null
  const label = (value: WorkspaceTarget) =>
    normalizeWorkspaceSeparators(value.path).replace(/\/+$/, '').split('/').at(-1) || value.path
  return (
    <ActionMenu
      testId="workspace-file-root-selector"
      menuTestId="workspace-file-root-menu"
      ariaLabel={t('workbench.workspace_file_choose_root')}
      icon={Folder}
      placement="bottom-end"
      triggerLabel={<span className="min-w-0 truncate">{label(target)}</span>}
      density="dense"
      triggerClassName="flex max-w-52 items-center gap-1.5 rounded-lg border border-border px-2 text-sm text-text-primary hover:bg-muted"
      items={unique.map(candidate => ({
        testId: `workspace-file-root-option-${candidate.path}`,
        label: <span title={candidate.path}>{label(candidate)}</span>,
        icon: Folder,
        checked: candidate.deviceId === target.deviceId && candidate.path === target.path,
        onSelect: () => onSelect(candidate),
      }))}
    />
  )
}

export function WorkspaceFileToolbar({
  path,
  isDirectory,
  target,
  api,
  textContent,
  canCopyContents,
  onSelect,
  children,
}: WorkspaceFileToolbarProps) {
  const { t } = useTranslation('common')
  const preferred = usePreferredWorkspaceOpener(target.path)
  const [opening, setOpening] = useState(false)
  const [operationError, setActionError] = useState<string | null>(null)
  const [dismissedReadFailure, setDismissedReadFailure] = useState<unknown>()
  const local = target.workspaceSource !== 'remote' && isLocalTerminalAvailable()
  const scope = useMemo(
    () => ({ deviceId: target.deviceId, root: target.path, path, local }),
    [target.deviceId, target.path, path, local]
  )
  const [contextState, setContext] = useState<{
    scope: typeof scope
    isDirectory: boolean
    position: MenuPosition
    path: string
  } | null>(null)
  const context = contextState?.scope === scope ? contextState : null
  const contextPath = context?.path ?? path
  const contextIsDirectory = context?.isDirectory ?? isDirectory
  const openerSnapshot = useLocalWorkspaceOpeners(local)
  const openers =
    openerSnapshot.status === 'error'
      ? []
      : (openerSnapshot.data?.filter(item => item.available && item.id !== 'file-manager') ?? null)
  const hostedResource = useMemo(
    () =>
      createAsyncResource(
        ['hosted-file', target.deviceId, target.path, contextPath].join(':'),
        async () =>
          normalizeHostedFileTarget(
            await invokeDesktopHost<unknown>('workspace.fileGitHubUrl', { path: contextPath })
          ),
        { refreshOnSubscribe: true }
      ),
    [contextPath, target.deviceId, target.path]
  )
  const hostedSnapshot = useSyncExternalStore(
    local && !contextIsDirectory ? hostedResource.subscribe : subscribeIdleResource,
    hostedResource.getSnapshot,
    hostedResource.getSnapshot
  )
  const contextHostedFileTarget =
    local && !contextIsDirectory && hostedSnapshot.status === 'ready'
      ? (hostedSnapshot.data ?? null)
      : null
  const readFailure = local
    ? (openerSnapshot.failure ??
      (context && !contextIsDirectory && hostedSnapshot.status === 'error'
        ? hostedSnapshot
        : undefined))
    : undefined
  const actionError =
    operationError ??
    (readFailure && readFailure !== dismissedReadFailure ? String(readFailure.error) : null)
  const normalizedPath = normalizeWorkspaceSeparators(path)
  const separator = normalizedPath.lastIndexOf('/')
  const name = normalizedPath.slice(separator + 1) || path

  const selectedOpener = resolveWorkspaceOpener(
    (openers ?? []).map(item => item.id),
    preferred
  )
  const activeOpener = openers?.find(item => item.id === selectedOpener)
  const run = async (action: () => Promise<unknown>) => {
    setActionError(null)
    setDismissedReadFailure(readFailure)
    try {
      await action()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }
  const open = async (filePath: string, opener?: LocalWorkspaceOpenerId) => {
    if (opening) return
    setOpening(true)
    await run(async () => {
      if (opener) {
        await invokeDesktopHost('workspace.openFile', { path: filePath, opener })
        setPreferredWorkspaceOpener(target.path, opener)
      } else {
        await openLocalFile(filePath)
      }
    })
    setOpening(false)
  }
  const openContextMenu = (filePath: string, directory: boolean, position: MenuPosition) => {
    if (local && !directory && filePath === contextPath && hostedSnapshot.status !== 'loading') {
      void hostedResource.reload()
    }
    setContext({ scope, isDirectory: directory, path: filePath, position })
  }

  const applicationItems = (filePath: string): ActionMenuItem[] =>
    prioritizeWorkspaceOpener(openers ?? [], preferred).map(opener => ({
      testId: `workspace-file-open-file-option-${opener.label ?? opener.id}`,
      label: (
        <>
          <LocalWorkspaceOpenerIcon opener={opener.id} className="h-4 w-4 shrink-0" />
          {opener.label ?? opener.id}
        </>
      ),
      disabled: opening,
      onSelect: () => open(filePath, opener.id),
    }))
  const contextItems: ActionMenuItem[] = [
    ...(local && activeOpener
      ? [
          {
            testId: 'workspace-file-open-preferred',
            label: (
              <>
                <LocalWorkspaceOpenerIcon opener={activeOpener.id} className="h-4 w-4 shrink-0" />
                {t('workbench.workspace_file_open_in', {
                  app: activeOpener.label ?? activeOpener.id,
                })}
              </>
            ),
            disabled: opening,
            onSelect: () => open(contextPath, activeOpener.id),
          },
          {
            testId: 'workspace-file-open-with',
            label: t('workbench.workspace_file_open_with'),
            children: applicationItems(contextPath),
          },
        ]
      : []),
    ...(local
      ? [
          ...(contextHostedFileTarget
            ? [
                {
                  testId: 'workspace-file-github',
                  label: t(
                    contextHostedFileTarget.provider === 'gitlab'
                      ? 'workbench.workspace_file_gitlab'
                      : contextHostedFileTarget.provider === 'git'
                        ? 'workbench.workspace_file_git'
                        : 'workbench.workspace_file_github'
                  ),
                  onSelect: () =>
                    run(() =>
                      invokeDesktopHost('shell.openExternal', { url: contextHostedFileTarget.url })
                    ),
                },
              ]
            : []),
          ...(activeOpener || contextHostedFileTarget
            ? [{ testId: 'workspace-file-action-separator', label: '', separator: true }]
            : []),
          ...(!contextIsDirectory
            ? [
                {
                  testId: 'workspace-file-save-as',
                  label: t('workbench.workspace_file_save_as'),
                  onSelect: () =>
                    run(() => invokeDesktopHost('workspace.saveFileAs', { path: contextPath })),
                },
              ]
            : []),
        ]
      : []),
    {
      testId: 'workspace-file-copy-path',
      label: t('workbench.workspace_file_copy_path'),
      onSelect: () => run(() => copyTextToClipboard(contextPath)),
    },
    ...(!contextIsDirectory
      ? [
          {
            testId: 'workspace-file-copy-contents',
            label: t('workbench.workspace_file_copy_contents'),
            disabled:
              contextPath === path
                ? !canCopyContents || (!local && textContent === undefined)
                : !local || workspaceFilePreviewKind(contextPath) !== 'text',
            onSelect: () =>
              run(() =>
                contextPath === path && textContent !== undefined
                  ? copyTextToClipboard(textContent)
                  : invokeDesktopHost('workspace.copyFileContents', { path: contextPath })
              ),
          },
        ]
      : []),
    ...(local
      ? [
          {
            testId: 'workspace-file-reveal-location-button',
            label: fileManagerRevealLabel(t),
            onSelect: () => run(() => revealLocalFile(contextPath)),
          },
        ]
      : []),
  ]
  return (
    <>
      <header
        data-testid="workspace-file-toolbar"
        className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3"
      >
        <div
          data-testid="workspace-file-path"
          className="flex min-w-0 items-center text-sm text-text-secondary"
          title={path}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
            void openContextMenu(path, isDirectory, { left: event.clientX, top: event.clientY })
          }}
          onKeyDown={event => {
            if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            void openContextMenu(path, isDirectory, { left: rect.left, top: rect.bottom })
          }}
        >
          <WorkspaceFileBreadcrumbs
            path={path}
            isDirectory={isDirectory}
            target={target}
            api={api}
            onSelect={onSelect}
            onPathContextMenu={(filePath, directory, position) => {
              void openContextMenu(filePath, directory, position)
            }}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {children}
          {local && (
            <div className="inline-flex h-[30px] items-center rounded-lg border border-border">
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="workspace-file-open-file-button"
                disabled={opening || openers === null}
                onClick={() => void open(path, activeOpener?.id)}
                className="flex h-7 items-center gap-1.5 rounded-l-lg px-2 text-sm text-text-primary hover:bg-muted disabled:opacity-60"
              >
                {opening || openers === null ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : activeOpener ? (
                  <LocalWorkspaceOpenerIcon opener={activeOpener.id} className="h-4 w-4" />
                ) : (
                  <FileOutput className="h-4 w-4" />
                )}
                {t('workbench.workspace_file_open')}
              </ControlButton>
              {!isDirectory && (
                <ActionMenu
                  testId="workspace-file-open-file-picker-button"
                  menuTestId="workspace-file-open-file-picker-menu"
                  ariaLabel={t('workbench.workspace_file_choose_opener')}
                  icon={ChevronDown}
                  placement="bottom-end"
                  density="dense"
                  triggerClassName="flex items-center justify-center rounded-r-lg text-text-secondary hover:bg-muted"
                  items={[
                    ...applicationItems(path),
                    { testId: 'workspace-file-opener-separator', label: '', separator: true },
                    {
                      testId: 'workspace-file-reveal-location-button',
                      label: t('workbench.workspace_file_reveal_location'),
                      onSelect: () => run(() => revealLocalFile(path)),
                    },
                  ]}
                />
              )}
            </div>
          )}
        </div>
      </header>
      {context && (
        <ActionMenu
          testId="workspace-file-context-trigger"
          menuTestId="workspace-file-context-menu"
          ariaLabel={name}
          triggerClassName="hidden"
          showTriggerTooltip={false}
          items={contextItems}
          contextMenuPosition={context.position}
          submenuCloseDelayMs={0}
          onContextMenuClose={() => setContext(null)}
        />
      )}
      {actionError && (
        <div
          role="alert"
          data-testid="workspace-file-action-error"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-sm text-destructive wework:text-red-600"
        >
          <span className="min-w-0 flex-1 break-words">{actionError}</span>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="workspace-file-action-error-dismiss"
            aria-label={t('common.close')}
            onClick={() => {
              setActionError(null)
              setDismissedReadFailure(readFailure)
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </ControlButton>
        </div>
      )}
    </>
  )
}
