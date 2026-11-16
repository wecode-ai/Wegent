// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationExecutionEnvironment } from '../types'
import { ChevronRight, Monitor } from 'lucide-react'
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
    environment =>
      environment.device_id != null &&
      environment.can_use !== false &&
      environment.status === 'online'
  )
  return (
    <details
      className="collaboration-runtime-disclosure"
      data-testid="template-environment-selection"
    >
      <summary data-testid="template-environment-selection-toggle">
        <ChevronRight aria-hidden="true" />
        <span>{m.optionalRuntimeConfiguration}</span>
      </summary>
      <div className="collaboration-runtime-disclosure-body">
        <p className="collaboration-runtime-hint">{m.deferredRuntimeHint}</p>
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
          <label className="collaboration-runtime-device" key={environment.id}>
            <input
              type="checkbox"
              data-testid={`template-authorize-environment-${environment.device_id}`}
              disabled={disabled}
              checked={selected.includes(environment.device_id!)}
              onChange={event =>
                onChange(
                  event.target.checked
                    ? [...selected, environment.device_id!]
                    : selected.filter(id => id !== environment.device_id)
                )
              }
            />
            <Monitor aria-hidden="true" />
            <span className="collaboration-runtime-device-name" title={environment.name}>
              {environment.name}
            </span>
            <span className="collaboration-runtime-device-status">{m.environmentOnline}</span>
          </label>
        ))}
        {available.length > 0 && (
          <p className="collaboration-runtime-hint">{m.environmentAuthorizationHint}</p>
        )}
        {!available.length && !loading && !error && (
          <p className="collaboration-runtime-hint">{m.selectExecutionEnvironment}</p>
        )}
      </div>
    </details>
  )
}
