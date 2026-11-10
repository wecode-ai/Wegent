// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react'
import { ChevronRight, FolderOpen, X } from 'lucide-react'
import type { CollaborationWorkspace } from '../types'
import type { ResourceCatalogKind } from './resourceCatalogModel'
import type { PlatformMessages } from './platformMessages'

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
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(
    null,
  )
  return (
    <div
      className="collaboration-resource-dialog-backdrop"
      role="presentation"
      onMouseDown={() => onClose()}
    >
      <section
        className="collaboration-resource-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={messages.chooseSpace}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>{messages.chooseSpace}</h2>
            <p>{messages.chooseSpaceHint}</p>
          </div>
          <button
            type="button"
            aria-label={messages.cancel}
            onClick={() => onClose()}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="collaboration-resource-space-options">
          {workspaces.length ? (
            workspaces.map((workspace) => (
              <button
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
              </button>
            ))
          ) : (
            <p>{messages.noAvailableSpaces}</p>
          )}
        </div>
      </section>
    </div>
  )
}
