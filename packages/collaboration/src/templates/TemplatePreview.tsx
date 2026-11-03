// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationLocale } from '../i18n'
import type { CollaborationTemplate } from './types'
import { templateMessages } from './messages'

export function TemplatePreview({
  document,
  locale,
}: {
  document: CollaborationTemplate
  locale: CollaborationLocale
}) {
  const m = templateMessages[locale]
  return (
    <div className="collaboration-template-preview" data-testid="collaboration-template-preview">
      <p className="collaboration-template-muted">{document.spec.description}</p>
      <span className="collaboration-template-meta">
        {m.version} {document.spec.version}
      </span>
      <div className="collaboration-template-muted" data-testid="template-project-defaults">
        <p>
          {locale === 'zh-CN'
            ? '项目默认设置（在项目内应用时生效）'
            : 'Project defaults (applied when used in a project)'}
        </p>
        {document.spec.resources.collaboration.project.taskAssignment?.enabled && (
          <p>
            {locale === 'zh-CN' ? '新任务自动交给小组：' : 'Route new issues to: '}
            {
              document.spec.resources.collaboration.groups.find(
                group =>
                  group.key ===
                  document.spec.resources.collaboration.project.taskAssignment?.groupKey
              )?.name
            }
          </p>
        )}
        {document.spec.resources.collaboration.project.board && (
          <p>
            {locale === 'zh-CN' ? '阶段看板：' : 'Stage board: '}
            {document.spec.resources.collaboration.project.board.tags.join(' → ')}
          </p>
        )}
      </div>
      {document.spec.resources.collaboration.groups.map(group => (
        <section key={group.key}>
          <h3>{group.name}</h3>
          <div className="collaboration-template-roles">
            {group.roles.map(role => (
              <div key={role.key}>
                <strong>{role.name}</strong>
                {role.defaultKind === 'agent' && (
                  <span className="collaboration-template-meta">
                    {locale === 'zh-CN' ? ' · 默认智能体' : ' · Agent by default'}
                  </span>
                )}
                <p>{role.responsibility}</p>
              </div>
            ))}
          </div>
          <h4>{m.stages}</h4>
          <ol className="collaboration-template-stages">
            {group.stages.map(stage => (
              <li key={stage.key}>{stage.name}</li>
            ))}
          </ol>
          <details>
            <summary>{m.details}</summary>
            <p>{group.instructions}</p>
            {group.stages.map(stage => (
              <p key={stage.key}>
                <strong>{stage.name}</strong> ·{' '}
                {[stage.description, ...stage.deliverables, stage.acceptance]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            ))}
          </details>
        </section>
      ))}
    </div>
  )
}
