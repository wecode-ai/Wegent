// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type FormEvent } from 'react'

import type { CollaborationApi } from './api'
import type { CollaborationProject, CollaborationStatus, CollaborationStatusColor } from './types'

const STATUS_COLORS: CollaborationStatusColor[] = [
  'gray',
  'blue',
  'orange',
  'purple',
  'green',
  'red',
]

interface CollaborationSettingsProps {
  api: CollaborationApi
  project: CollaborationProject
  labels: {
    settings: string
    projectName: string
    projectDescription: string
    visibility: string
    privateVisibility: string
    publicVisibility: string
    tags: string
    tagsHint: string
    boardLayout: string
    boardLayoutHint: string
    statusName: string
    statusColor: string
    processingStatus: string
    addStatus: string
    remove: string
    moveUp: string
    moveDown: string
    cardDisplay: string
    showAssignee: string
    showPriority: string
    showTags: string
    showDate: string
    repository: string
    providerToken: string
    providerTokenHint: string
    aitableUrl: string
    save: string
    archiveProject: string
    archiveConfirm: string
  }
  onChange(project: CollaborationProject): void
  onArchived(): void
  onConflict(): Promise<void>
  onError(): void
}

function defaultStatuses(project: CollaborationProject): CollaborationStatus[] {
  return (
    project.board_config?.statuses ?? [
      { id: 'pending', name: 'Pending', color: 'gray' },
      { id: 'in_progress', name: 'In progress', color: 'blue' },
      { id: 'completed', name: 'Completed', color: 'green' },
    ]
  )
}

export function CollaborationSettings({
  api,
  project,
  labels,
  onChange,
  onArchived,
  onConflict,
  onError,
}: CollaborationSettingsProps) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [visibility, setVisibility] = useState(project.visibility ?? 'private')
  const [tags, setTags] = useState(project.tags.join(', '))
  const [statuses, setStatuses] = useState(() => defaultStatuses(project))
  const [processingStatus, setProcessingStatus] = useState(
    project.board_config?.processing_start_status_id ?? defaultStatuses(project)[0]?.id ?? ''
  )
  const [cardDisplay, setCardDisplay] = useState(
    project.card_display ?? {
      show_assignee: true,
      show_priority: true,
      show_tags: true,
      show_date: true,
    }
  )
  const [repository, setRepository] = useState(
    typeof project.provider_config.repository === 'string' ? project.provider_config.repository : ''
  )
  const [providerToken, setProviderToken] = useState('')
  const [aitableUrl, setAitableUrl] = useState(
    typeof project.provider_config.source_url === 'string' ? project.provider_config.source_url : ''
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const nextStatuses = defaultStatuses(project)
    setName(project.name)
    setDescription(project.description)
    setVisibility(project.visibility ?? 'private')
    setTags(project.tags.join(', '))
    setStatuses(nextStatuses)
    setProcessingStatus(
      project.board_config?.processing_start_status_id ?? nextStatuses[0]?.id ?? ''
    )
    setCardDisplay(
      project.card_display ?? {
        show_assignee: true,
        show_priority: true,
        show_tags: true,
        show_date: true,
      }
    )
    setRepository(
      typeof project.provider_config.repository === 'string'
        ? project.provider_config.repository
        : ''
    )
    setProviderToken('')
    setAitableUrl(
      typeof project.provider_config.source_url === 'string'
        ? project.provider_config.source_url
        : ''
    )
  }, [project])

  const moveStatus = (index: number, offset: -1 | 1) => {
    const target = index + offset
    if (target < 0 || target >= statuses.length) return
    const next = [...statuses]
    ;[next[index], next[target]] = [next[target], next[index]]
    setStatuses(next)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const providerConfig = { ...project.provider_config }
      if (project.task_provider === 'github' || project.task_provider === 'gitlab') {
        providerConfig.repository = repository.trim()
        if (providerToken.trim()) providerConfig.token = providerToken.trim()
      }
      if (project.task_provider === 'dingtalk_aitable') {
        providerConfig.source_url = aitableUrl.trim()
      }
      onChange(
        await api.updateProject(project.id, {
          version: project.version,
          name: name.trim(),
          description: description.trim(),
          visibility,
          tags: tags
            .split(',')
            .map(tag => tag.trim())
            .filter((tag, index, values) => tag && values.indexOf(tag) === index),
          board_config: {
            group_by: project.board_config?.group_by ?? 'status',
            processing_start_status_id: processingStatus || null,
            statuses,
          },
          card_display: cardDisplay,
          provider_config: providerConfig,
        })
      )
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
        await onConflict()
      } else {
        onError()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="collaboration-panel collaboration-settings"
      data-testid="collaboration-project-settings"
      onSubmit={submit}
    >
      <h2>{labels.settings}</h2>
      <label>
        {labels.projectName}
        <input value={name} onChange={event => setName(event.target.value)} />
      </label>
      <label>
        {labels.projectDescription}
        <textarea value={description} onChange={event => setDescription(event.target.value)} />
      </label>
      <label>
        {labels.visibility}
        <select
          value={visibility}
          onChange={event => setVisibility(event.target.value as 'private' | 'public')}
        >
          <option value="private">{labels.privateVisibility}</option>
          <option value="public">{labels.publicVisibility}</option>
        </select>
      </label>
      <label>
        {labels.tags}
        <input value={tags} onChange={event => setTags(event.target.value)} />
        <small>{labels.tagsHint}</small>
      </label>

      <fieldset className="collaboration-settings-section">
        <legend>{labels.boardLayout}</legend>
        <p>{labels.boardLayoutHint}</p>
        {statuses.map((status, index) => (
          <div className="collaboration-status-editor" key={status.id}>
            <input
              aria-label={labels.statusName}
              value={status.name}
              onChange={event =>
                setStatuses(current =>
                  current.map(item =>
                    item.id === status.id ? { ...item, name: event.target.value } : item
                  )
                )
              }
            />
            <select
              aria-label={labels.statusColor}
              value={status.color}
              onChange={event =>
                setStatuses(current =>
                  current.map(item =>
                    item.id === status.id
                      ? { ...item, color: event.target.value as CollaborationStatusColor }
                      : item
                  )
                )
              }
            >
              {STATUS_COLORS.map(color => (
                <option value={color} key={color}>
                  {color}
                </option>
              ))}
            </select>
            <button type="button" disabled={index === 0} onClick={() => moveStatus(index, -1)}>
              {labels.moveUp}
            </button>
            <button
              type="button"
              disabled={index === statuses.length - 1}
              onClick={() => moveStatus(index, 1)}
            >
              {labels.moveDown}
            </button>
            <button
              type="button"
              disabled={statuses.length === 1}
              onClick={() => {
                const next = statuses.filter(item => item.id !== status.id)
                setStatuses(next)
                if (processingStatus === status.id) setProcessingStatus(next[0]?.id ?? '')
              }}
            >
              {labels.remove}
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            const id = `status-${Date.now().toString(36)}`
            setStatuses(current => [
              ...current,
              {
                id,
                name: labels.addStatus,
                color: STATUS_COLORS[current.length % STATUS_COLORS.length],
              },
            ])
          }}
        >
          {labels.addStatus}
        </button>
        <label>
          {labels.processingStatus}
          <select
            value={processingStatus}
            onChange={event => setProcessingStatus(event.target.value)}
          >
            {statuses.map(status => (
              <option value={status.id} key={status.id}>
                {status.name}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="collaboration-settings-section">
        <legend>{labels.cardDisplay}</legend>
        {(
          [
            ['show_assignee', labels.showAssignee],
            ['show_priority', labels.showPriority],
            ['show_tags', labels.showTags],
            ['show_date', labels.showDate],
          ] as const
        ).map(([key, label]) => (
          <label className="collaboration-checkbox" key={key}>
            <input
              type="checkbox"
              checked={cardDisplay[key]}
              onChange={event =>
                setCardDisplay(current => ({ ...current, [key]: event.target.checked }))
              }
            />
            {label}
          </label>
        ))}
      </fieldset>

      {(project.task_provider === 'github' || project.task_provider === 'gitlab') && (
        <fieldset className="collaboration-settings-section">
          <label>
            {labels.repository}
            <input value={repository} onChange={event => setRepository(event.target.value)} />
          </label>
          <label>
            {labels.providerToken}
            <input
              type="password"
              value={providerToken}
              placeholder={labels.providerTokenHint}
              onChange={event => setProviderToken(event.target.value)}
            />
          </label>
        </fieldset>
      )}

      {project.task_provider === 'dingtalk_aitable' && (
        <label>
          {labels.aitableUrl}
          <input value={aitableUrl} onChange={event => setAitableUrl(event.target.value)} />
        </label>
      )}

      <div className="collaboration-settings-actions">
        <button
          type="submit"
          className="collaboration-primary-button"
          disabled={saving || !name.trim() || statuses.some(status => !status.name.trim())}
        >
          {labels.save}
        </button>
        <button
          type="button"
          className="collaboration-danger-button"
          onClick={async () => {
            if (!window.confirm(labels.archiveConfirm)) return
            try {
              await api.archiveProject(project.id, project.version)
              onArchived()
            } catch {
              onError()
            }
          }}
        >
          {labels.archiveProject}
        </button>
      </div>
    </form>
  )
}
