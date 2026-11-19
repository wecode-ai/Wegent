// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useFocusRequest } from '../dom-events'
import { createPortal } from 'react-dom'
import { ProjectCreateConfigurationView } from '../project-create/ProjectCreateConfigurationView'
import type { CollaborationLocale } from '../i18n'
import type {
  ProjectCreateCollaborationGroupDraft,
  ProjectCreateResourceSetup,
} from '../project-create/types'
import type { CollaborationTemplate } from './types'
import { useCollaborationTemplateStore } from './context'
import { templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { CollaborationTemplatePage } from './CollaborationTemplatePage'
import { TemplateBindings } from './TemplateBindings'
import {
  createTemplatePageNavigation,
  templatePageDetail,
  type TemplatePageNavigation,
} from './templatePageNavigation'

export function TemplateCreateSection({
  setup,
  locale,
  initialTemplate,
  disabled,
  onSelect,
  onChange,
  configurationHost,
}: {
  setup: ProjectCreateResourceSetup
  locale: CollaborationLocale
  initialTemplate?: CollaborationTemplate | null
  disabled?: boolean
  configurationHost?: {
    target: HTMLElement | null
    navigation: TemplatePageNavigation
  }
  onSelect(document: CollaborationTemplate | null): void
  onChange(
    drafts: ProjectCreateCollaborationGroupDraft[] | null,
    selected: boolean,
    document?: CollaborationTemplate
  ): void
}) {
  const store = useCollaborationTemplateStore()
  const m = templateMessages[locale]
  const [document, setDocument] = useState(initialTemplate ?? null)
  const [selectionVersion, setSelectionVersion] = useState(0)
  const navigation = useMemo(
    () => configurationHost?.navigation ?? createTemplatePageNavigation(store),
    [configurationHost?.navigation, store]
  )
  const navigationState = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
    navigation.getSnapshot
  )
  const { view } = navigationState
  const detail = templatePageDetail(navigation, locale, navigationState)
  const [catalogFooterTarget, setCatalogFooterTarget] = useState<HTMLElement | null>(null)
  const [complete, setComplete] = useState(true)
  const section = useRef<HTMLElement>(null)
  const [configuredRoleCount, setConfiguredRoleCount] = useState<number | null>(null)
  const leave = navigation.leave
  useFocusRequest(section, navigationState.sectionFocusRequest, {
    enabled: !view && navigationState.sectionFocusRequest > 0,
    selector: document
      ? '[data-testid="project-create-configure-template"]'
      : '[data-testid="project-create-choose-template"]',
  })
  const showBindings = () => {
    navigation.showBindings()
  }
  const showCatalog = () => {
    navigation.showCatalog()
  }
  if (!store) return null
  const members = [
    { user_id: setup.currentUser.id, user_name: setup.currentUser.name },
    ...setup.members.filter(member => member.user_id !== setup.currentUser.id),
  ]
  const bindings = document && (
    <TemplateBindings
      key={selectionVersion}
      document={document}
      locale={locale}
      disabled={disabled}
      currentUserId={setup.currentUser.id}
      candidates={[
        ...members.map(member => ({
          kind: 'human' as const,
          id: String(member.user_id),
          name: member.user_name,
          label: member.user_name,
          responsibility: '',
        })),
        ...setup.agents.map(agent => ({
          kind: 'agent' as const,
          id: agent.id,
          name: agent.name,
          label: agent.name,
          responsibility: '',
        })),
      ]}
      onChange={(drafts, configured) => {
        setComplete(Boolean(drafts))
        setConfiguredRoleCount(
          configured.spec.resources.collaboration.groups.reduce(
            (count, group) => count + group.roles.length,
            0
          )
        )
        onChange(drafts, true, configured)
      }}
    />
  )
  const catalog = (
    <CollaborationTemplatePage
      store={store}
      locale={locale}
      embedded={Boolean(configurationHost)}
      footerTarget={catalogFooterTarget}
      navigation={configurationHost ? navigation : undefined}
      onUse={record => {
        setSelectionVersion(current => current + 1)
        setDocument(record.document)
        onChange(null, true)
        onSelect(record.document)
        if (configurationHost) showBindings()
        else navigation.leave()
      }}
    />
  )
  return (
    <section
      ref={section}
      className="collaboration-template-create-section"
      data-testid="project-create-template-section"
    >
      <div className="collaboration-template-page-heading">
        <h3>{document ? `${m.selected} · ${document.spec.displayName}` : m.title}</h3>
        <div className="collaboration-template-actions">
          <button
            type="button"
            className="collaboration-template-choice"
            data-testid="project-create-choose-template"
            disabled={disabled}
            onClick={showCatalog}
          >
            {m.discover}
          </button>
          {document && (
            <button
              type="button"
              className="collaboration-template-choice"
              data-testid="project-create-configure-template"
              disabled={disabled}
              onClick={showBindings}
            >
              {m.configureSelection}
            </button>
          )}
          {document && (
            <button
              type="button"
              className="collaboration-template-choice"
              data-testid="project-create-clear-template"
              disabled={disabled}
              onClick={() => {
                setDocument(null)
                setConfiguredRoleCount(null)
                onSelect(null)
                onChange([], false)
              }}
            >
              {m.clearSelection}
            </button>
          )}
        </div>
      </div>
      {document && configurationHost && (
        <>
          <p className="collaboration-template-muted" data-testid="project-create-template-summary">
            {m.selectionSummary
              .replace('{groups}', String(document.spec.resources.collaboration.groups.length))
              .replace(
                '{roles}',
                String(
                  configuredRoleCount ??
                    document.spec.resources.collaboration.groups.reduce(
                      (count, group) => count + group.roles.length,
                      0
                    )
                )
              )}
          </p>
          {!complete && <p className="collaboration-template-error">{m.selectionIncomplete}</p>}
        </>
      )}
      {configurationHost?.target
        ? createPortal(
            <>
              {document && (
                <ProjectCreateConfigurationView
                  active={view === 'bindings'}
                  onBack={leave}
                  backLabel={m.returnToProject}
                  testId="project-create-template-configuration"
                  footer={
                    <button
                      type="button"
                      className="collaboration-primary-button"
                      data-testid="project-create-template-configuration-apply"
                      disabled={!complete || disabled}
                      onClick={leave}
                    >
                      {m.confirmConfiguration}
                    </button>
                  }
                >
                  {bindings}
                </ProjectCreateConfigurationView>
              )}
              {view === 'catalog' && (
                <ProjectCreateConfigurationView
                  onBack={detail?.onBack ?? leave}
                  backLabel={detail ? m.returnToTemplates : m.returnToProject}
                  testId="project-create-template-catalog"
                  footer={
                    <div
                      ref={setCatalogFooterTarget}
                      className="collaboration-template-actions collaboration-template-step-actions"
                      data-testid="project-create-template-catalog-actions"
                    />
                  }
                >
                  {catalog}
                </ProjectCreateConfigurationView>
              )}
            </>,
            configurationHost.target
          )
        : bindings}
      {!configurationHost && view === 'catalog' && (
        <TemplateDialog title={m.title} closeLabel={m.close} onClose={leave}>
          {catalog}
        </TemplateDialog>
      )}
    </section>
  )
}
