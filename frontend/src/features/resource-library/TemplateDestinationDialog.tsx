// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CollaborationProject, CollaborationLocale } from '@wegent/collaboration'
import {
  ProjectTemplateApplyDialog,
  TemplateDialog,
  templateIdentity,
  templateMessages,
  type TemplateRecord,
} from '@wegent/collaboration/templates'
import apiClient from '@/apis/client'
import { createWebSharedWorkspaceApi } from '@/features/collaboration/shared-api'
import { webProjectAgentConfigurationHost } from '@/features/collaboration/ProjectAgentConfigurationHost'
import { collaborationLocationPath } from '@/features/collaboration/routes'

export function TemplateDestinationDialog({
  record,
  locale,
  ownerId,
  onClose,
}: {
  record: TemplateRecord
  locale: CollaborationLocale
  ownerId: number
  onClose(): void
}) {
  const router = useRouter()
  const m = templateMessages[locale]
  const api = useMemo(() => createWebSharedWorkspaceApi(apiClient), [])
  const [projects, setProjects] = useState<CollaborationProject[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setError(false)
    void api.projects
      .list()
      .then(items => {
        if (active)
          setProjects(
            items.filter(
              project =>
                project.workspace_id &&
                project.status === 'active' &&
                ['Owner', 'Maintainer'].includes(project.access_role ?? '')
            )
          )
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [api, attempt])
  if (selected)
    return (
      <ProjectTemplateApplyDialog
        key={selected}
        api={api}
        agentConfiguration={webProjectAgentConfigurationHost}
        projectId={selected}
        document={record.document}
        locale={locale}
        currentUserId={ownerId}
        onClose={() => setSelected(null)}
        onApplied={project => {
          onClose()
          router.push(
            collaborationLocationPath({
              platformView: 'spaces',
              workspaceId: project.workspace_id ?? null,
              workspaceView: 'projects',
              projectId: project.id,
              projectView: 'board',
              issueId: null,
            })
          )
        }}
      />
    )
  return (
    <TemplateDialog
      title={m.destination}
      description={record.document.spec.displayName}
      closeLabel={m.close}
      onClose={onClose}
    >
      <button
        type="button"
        className="collaboration-primary-button min-h-11"
        data-testid="template-create-project"
        onClick={() => {
          router.push(`/collaboration?template=${encodeURIComponent(templateIdentity(record))}`)
        }}
      >
        {m.newProject}
      </button>
      <h3 className="mt-6 mb-3">{m.existingProject}</h3>
      {error ? (
        <p role="alert">
          {m.failed}{' '}
          <button
            type="button"
            data-testid="template-destination-retry"
            onClick={() => setAttempt(value => value + 1)}
          >
            {m.retry}
          </button>
        </p>
      ) : projects === null ? (
        <p role="status">{m.loading}</p>
      ) : projects.length === 0 ? (
        <p>{m.noProjects}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {projects.map(project => (
            <button
              type="button"
              key={project.id}
              className="collaboration-template-choice min-h-11 text-left"
              data-testid={`template-project-${project.id}`}
              onClick={() => setSelected(project.id)}
            >
              {project.name} <span className="text-text-muted">{project.project_key}</span>
            </button>
          ))}
        </div>
      )}
    </TemplateDialog>
  )
}
