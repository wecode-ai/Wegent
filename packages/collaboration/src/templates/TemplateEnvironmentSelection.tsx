import { CollapsibleRoot, CollapsibleTrigger, CollapsiblePanel } from '../controls/Collapsible'
import { Checkbox } from '../controls/Checkbox'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Monitor } from 'lucide-react'
import type { CollaborationLocale } from '../i18n'
import type { CollaborationExecutionEnvironment } from '../types'
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
    <CollapsibleRoot
      className="collaboration-runtime-disclosure"
      data-testid="template-environment-selection"
    >
      <CollapsibleTrigger data-testid="template-environment-selection-toggle">
        <span>{m.optionalRuntimeConfiguration}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="collaboration-runtime-disclosure-body">
          <p className="collaboration-runtime-hint">{m.deferredRuntimeHint}</p>
          {loading && <p role="status">{m.loading}</p>}
          {error && (
            <p role="alert">
              {error}{' '}
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="template-environments-retry"
                onClick={onRetry}
              >
                {m.retry}
              </ControlButton>
            </p>
          )}
          {available.map(environment => (
            <label className="collaboration-runtime-device" key={environment.id}>
              <Checkbox
                data-testid={`template-authorize-environment-${environment.device_id}`}
                disabled={disabled}
                checked={selected.includes(environment.device_id!)}
                onCheckedChange={checked =>
                  onChange(
                    checked === true
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
      </CollapsiblePanel>
    </CollapsibleRoot>
  )
}
