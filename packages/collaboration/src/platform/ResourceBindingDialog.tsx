import { DialogSurface } from '../controls/DialogSurface'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0
import { ChevronRight, FolderOpen, X } from 'lucide-react'
import { useState } from 'react'
import type { CollaborationWorkspace } from '../types'
import type { PlatformMessages } from './platformMessages'
import type { ResourceCatalogKind } from './resourceCatalogModel'

export function ResourceBindingDialog({
  workspaces,
  kind,
  messages,
  onBind,
  onClose,
}: {
  workspaces: CollaborationWorkspace[]
  kind: ResourceCatalogKind
  messages: PlatformMessages
  onBind(workspaceId: string): Promise<void>
  onClose(): void
}) {
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null)
  return (
    <div
      className="collaboration-resource-dialog-backdrop"
      role="presentation"
      onMouseDown={() => onClose()}
    >
      <DialogSurface
        onClose={onClose}
        render={
          <section
            className="collaboration-resource-dialog"
            aria-label={messages.chooseSpace}
            onMouseDown={event => event.stopPropagation()}
          />
        }
      >
        <header>
          <div>
            <h2>{messages.chooseSpace}</h2>
            <p>{messages.chooseSpaceHint}</p>
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            aria-label={messages.cancel}
            onClick={() => onClose()}
          >
            <X aria-hidden="true" />
          </ControlButton>
        </header>
        <div className="collaboration-resource-space-options">
          {workspaces.length ? (
            workspaces.map(workspace => (
              <ControlButton
                variant="unstyled"
                type="button"
                key={workspace.id}
                data-testid={`collaboration-${kind}-space-${workspace.id}`}
                disabled={pendingWorkspaceId === workspace.id}
                onClick={() => {
                  setPendingWorkspaceId(workspace.id)
                  void onBind(workspace.id)
                    .then(() => onClose())
                    .finally(() => setPendingWorkspaceId(null))
                }}
              >
                <FolderOpen aria-hidden="true" />
                <span>
                  <strong>{workspace.name}</strong>
                </span>
                <ChevronRight aria-hidden="true" />
              </ControlButton>
            ))
          ) : (
            <p>{messages.noAvailableSpaces}</p>
          )}
        </div>
      </DialogSurface>
    </div>
  )
}
