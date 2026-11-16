// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationExecutionEnvironment, CollaborationProject } from '../types'
import type { CollaborationLocale } from '../i18n'
import { templateMessages } from './messages'

export function TemplateProjectEnvironment({
  host,
  project,
  locale,
  selected,
  disabled,
  onChange,
}: {
  host: ProjectAgentConfigurationHost
  project: CollaborationProject
  locale: CollaborationLocale
  selected: string | undefined
  disabled: boolean
  onChange(id: string | undefined): void
}) {
  const m = templateMessages[locale]
  const [environments, setEnvironments] = useState<CollaborationExecutionEnvironment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(false)
    void host.listTemplateAgentEnvironments!(project.id)
      .then(items => {
        if (!active) return
        const available = items.filter(item => item.can_use !== false && item.status === 'online')
        setEnvironments(available)
      })
      .catch(() => {
        if (active) setError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [host, project.id, revision])
  useEffect(() => {
    if (loading || error || environments.some(item => item.id === selected)) return
    const next = environments.length === 1 ? environments[0].id : undefined
    if (next !== selected) onChange(next)
  }, [environments, loading, error, selected, onChange])
  const settingsHref = host.templateAgentEnvironmentSettingsHref?.(project)
  return (
    <section
      className="collaboration-template-create-section"
      data-testid="template-project-environment"
    >
      <label className="collaboration-template-field">
        <span>{m.executionEnvironment}</span>
        <select
          data-testid="template-project-environment-select"
          value={selected ?? ''}
          disabled={disabled || loading || error}
          onChange={event => onChange(event.target.value || undefined)}
        >
          <option value="">{m.chooseProjectEnvironment}</option>
          {environments.map(environment => (
            <option key={environment.id} value={environment.id}>
              {environment.name}
            </option>
          ))}
        </select>
      </label>
      {loading && <p role="status">{m.loading}</p>}
      {error && <p role="alert">{m.failed}</p>}
      {!loading && !error && !environments.length && <p>{m.projectEnvironmentSetupHint}</p>}
      <div className="collaboration-template-actions">
        {settingsHref && (
          <a
            data-testid="template-project-environment-settings"
            href={settingsHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            {m.configureProjectEnvironment}
          </a>
        )}
        <button
          type="button"
          data-testid="template-project-environment-refresh"
          disabled={disabled || loading}
          onClick={() => setRevision(value => value + 1)}
        >
          {m.refresh}
        </button>
      </div>
    </section>
  )
}
