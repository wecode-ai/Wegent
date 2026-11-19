// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from 'react'
import type { TemplateProjectEnvironmentResource } from './templateProjectEnvironmentResource'
import type { CollaborationLocale } from '../i18n'
import { templateMessages } from './messages'

export function TemplateProjectEnvironment({
  resource,
  locale,
  disabled,
}: {
  resource: TemplateProjectEnvironmentResource
  locale: CollaborationLocale
  disabled: boolean
}) {
  const m = templateMessages[locale]
  const state = useSyncExternalStore(
    resource.catalog.subscribe,
    resource.catalog.getSnapshot,
    resource.catalog.getSnapshot
  )
  const selected = useSyncExternalStore(
    resource.subscribeSelection,
    resource.getSelection,
    resource.getSelection
  )
  const environments = state.data ?? []
  const loading = state.status === 'idle' || state.status === 'loading'
  const error = state.status === 'error'
  const settingsHref = resource.settingsHref()
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
          onChange={event => resource.select(event.target.value || undefined)}
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
          onClick={() => void resource.catalog.reload()}
        >
          {m.refresh}
        </button>
      </div>
    </section>
  )
}
