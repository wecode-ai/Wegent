import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { Button as ControlButton } from '../markdown/Button'
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
        <SelectRoot
          disabled={disabled || loading || error}
          value={String(selected ?? '')}
          onValueChange={selectedValue => {
            if (selectedValue === null) return
            return resource.select(selectedValue || undefined)
          }}
        >
          <SelectTrigger data-testid="template-project-environment-select" />
          <SelectContent>
            <SelectItem value="">{m.chooseProjectEnvironment}</SelectItem>
            {environments.map(environment => (
              <SelectItem key={environment.id} value={String(environment.id)}>
                {environment.name}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
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
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="template-project-environment-refresh"
          disabled={disabled || loading}
          onClick={() => void resource.catalog.reload()}
        >
          {m.refresh}
        </ControlButton>
      </div>
    </section>
  )
}
