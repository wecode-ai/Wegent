// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationExecutionEnvironment } from '../types'
import type { CollaborationLocale } from '../i18n'
import { templateMessages } from './messages'

export function TemplateEnvironmentSelection({
  environments,
  selected,
  locale,
  disabled,
  onChange,
  loading,
  error,
  onRetry,
}: {
  environments: CollaborationExecutionEnvironment[]
  selected: number[]
  locale: CollaborationLocale
  disabled: boolean
  onChange(ids: number[]): void
  loading?: boolean
  error?: string
  onRetry?(): void
}) {
  const m = templateMessages[locale]
  const available = environments.filter(
    environment => environment.device_id != null && environment.can_use !== false
  )
  return (
    <section
      className="collaboration-template-create-section"
      data-testid="template-environment-selection"
    >
      <h3>{m.executionEnvironment}</h3>
      <p>{m.environmentAuthorizationHint}</p>
      {loading && <p role="status">{m.loading}</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" data-testid="template-environments-retry" onClick={onRetry}>
            {m.retry}
          </button>
        </p>
      )}
      {available.map(environment => (
        <label className="collaboration-template-field" key={environment.id}>
          <span>{environment.name}</span>
          <input
            type="checkbox"
            data-testid={`template-authorize-environment-${environment.device_id}`}
            disabled={disabled || environment.status !== 'online'}
            checked={selected.includes(environment.device_id!)}
            onChange={event =>
              onChange(
                event.target.checked
                  ? [...selected, environment.device_id!]
                  : selected.filter(id => id !== environment.device_id)
              )
            }
          />
        </label>
      ))}
      {!available.length && !loading && !error && <p>{m.selectExecutionEnvironment}</p>}
    </section>
  )
}
