// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react'
import type { CollaborationAgent, CollaborationMember, CollaborationProject } from '../types'
import type { CollaborationLocale, CollaborationTranslate } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { StrategyFunctionalRole, StrategyRoleMapping } from '../automation/types'
import { ProjectSettingsPage } from './ProjectSettingsPage'
import { strategyTextDiff } from './strategyTextDiff'

const roleNames: Record<StrategyFunctionalRole, readonly [string, string]> = {
  product: ['产品', 'Product'],
  development: ['研发', 'Development'],
  design: ['UI / 设计', 'UI / Design'],
  qa: ['测试', 'QA'],
  pmo: ['PMO', 'PMO'],
}
const emptyRoles: StrategyRoleMapping = {
  product: [],
  development: [],
  design: [],
  qa: [],
  pmo: [],
}

export function ProjectStrategySettings({
  api,
  project,
  members,
  locale,
  translate,
  onChange,
}: {
  api: Pick<SharedWorkspaceApi, 'projects'>
  project: CollaborationProject
  members: CollaborationMember[]
  agents?: CollaborationAgent[]
  locale: CollaborationLocale
  translate: CollaborationTranslate
  onChange(project: CollaborationProject): void
}) {
  const revision = project.collaboration_strategy
  const initialText = revision?.text ?? project.description ?? ''
  const [text, setText] = useState(initialText)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const synchronizedSource = useRef({ projectId: project.id, version: revision?.version ?? 0 })
  useEffect(() => {
    const version = revision?.version ?? 0
    if (
      synchronizedSource.current.projectId === project.id &&
      synchronizedSource.current.version === version
    )
      return
    synchronizedSource.current = { projectId: project.id, version }
    setText(revision?.text ?? project.description ?? '')
    setError(null)
    setSaved(false)
  }, [revision, project.description, project.id])
  const t = (chinese: string, english: string) => (locale === 'zh-CN' ? chinese : english)
  const canManage = project.access_role === 'Owner' || project.access_role === 'Maintainer'
  const disabled = !canManage || project.agentic_strategy_enabled !== true || busy
  const roles = revision?.role_mapping ?? emptyRoles
  const versions = project.collaboration_strategy_versions ?? []
  return (
    <ProjectSettingsPage
      title={t('项目协作策略', 'Project collaboration strategy')}
      description={t(
        '用可读文本约定收集箱准入与六阶段协作方式。',
        'Define inbox admission and six stages of collaboration in readable text.'
      )}
      testId="collaboration-project-strategy-settings"
    >
      <form
        className="space-y-5"
        data-testid="project-strategy-editor"
        onSubmit={async event => {
          event.preventDefault()
          if (disabled || !text.trim()) return
          setBusy(true)
          setError(null)
          setSaved(false)
          try {
            const updated = await api.projects.update(project.id, {
              version: project.version,
              collaborationStrategy: {
                text: text.trim(),
                expected_version: revision?.version ?? 0,
              },
            })
            onChange(updated)
            setSaved(true)
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : translate('saveFailed', '保存失败，请重试')
            )
          } finally {
            setBusy(false)
          }
        }}
      >
        <p className="text-sm text-text-secondary" data-testid="project-strategy-version">
          {revision
            ? t(`已发布 v${revision.version}`, `Published v${revision.version}`)
            : t('尚未发布项目策略', 'No published project strategy')}
        </p>
        <p className="text-sm text-text-secondary">
          {t(
            '收集箱完善定义后，依次进入需求提出、共同评审、开发准备、开发实现、质量验收、发布上线。',
            'Issues start in the inbox, then proceed through proposal, joint review, development preparation, implementation, quality acceptance and release.'
          )}
        </p>
        <label className="flex flex-col gap-2 text-sm text-text-primary">
          {t('协作策略文本', 'Collaboration strategy text')}
          <textarea
            value={text}
            maxLength={100000}
            disabled={disabled}
            data-testid="project-strategy-text"
            className="min-h-80 w-full resize-y rounded-md border border-border bg-background p-3 text-sm leading-relaxed text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/70 disabled:opacity-60"
            onChange={event => {
              setText(event.target.value)
              setSaved(false)
            }}
          />
        </label>
        <section
          className="space-y-2 text-sm text-text-secondary"
          data-testid="project-strategy-scope"
        >
          <h2 className="font-medium text-text-primary">{t('生效范围', 'Effective scope')}</h2>
          <p>
            {t(
              '发布只影响以后创建的 Issue。运行中的 Issue 固定使用创建时的策略快照；升级必须单独确认并填写原因。',
              'Publishing affects future Issues. Running Issues keep their original strategy snapshot; upgrading requires an explicit action and reason.'
            )}
          </p>
        </section>
        <section className="space-y-2 text-sm" data-testid="project-strategy-role-mapping">
          <h2 className="font-medium text-text-primary">
            {t('职能角色', 'Functional responsibilities')}
          </h2>
          <p className="text-text-secondary">
            {t(
              '职能由策略文本约定，权限仍由项目成员角色决定。这里只展示发布时解析的映射。',
              'The strategy defines responsibilities; project membership still controls permissions. These are the mappings resolved at publication.'
            )}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-text-secondary">
            {(Object.keys(roleNames) as StrategyFunctionalRole[]).map(role => (
              <div className="contents" key={role}>
                <dt>{roleNames[role][locale === 'zh-CN' ? 0 : 1]}</dt>
                <dd>
                  {roles[role].length
                    ? roles[role]
                        .map(
                          name =>
                            members.find(member => member.user_name === name)?.user_name ?? name
                        )
                        .join('、')
                    : t(
                        '待策略解析与项目成员匹配',
                        'Pending strategy and project participant matching'
                      )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <details className="text-sm" data-testid="project-strategy-draft-diff">
          <summary
            className="cursor-pointer py-2 text-text-primary"
            data-testid="project-strategy-draft-diff-toggle"
          >
            {t('查看与当前版本的差异', 'Compare with the current version')}
          </summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-xs text-text-secondary">
            {strategyTextDiff(revision?.text ?? '', text).map((line, index) => (
              <span className="block" data-change={line.kind} key={index}>
                {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
                {line.text || ' '}
              </span>
            ))}
          </pre>
        </details>
        {versions.length ? (
          <details className="text-sm" data-testid="project-strategy-history">
            <summary
              className="cursor-pointer py-2 text-text-primary"
              data-testid="project-strategy-history-toggle"
            >
              {t('策略版本与发布差异', 'Strategy versions and published changes')}
            </summary>
            {[...versions]
              .sort((left, right) => right.version - left.version)
              .map(version => (
                <details key={version.version} className="border-t border-border/40 py-2">
                  <summary
                    className="cursor-pointer text-text-primary"
                    data-testid={`project-strategy-version-${version.version}`}
                  >
                    v{version.version} ·{' '}
                    <time dateTime={version.published_at}>{version.published_at}</time>
                  </summary>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-text-secondary">
                    {version.diff || version.text}
                  </pre>
                </details>
              ))}
          </details>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-error" data-testid="project-strategy-save-error">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p
            role="status"
            className="text-sm text-text-secondary"
            data-testid="project-strategy-saved"
          >
            {t('策略新版本已发布', 'New strategy version published')}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={disabled || !text.trim() || text === revision?.text}
          className="min-h-11 rounded-md bg-text-primary px-4 text-sm text-background disabled:opacity-50 md:min-h-8"
          data-testid="project-strategy-save"
        >
          {busy ? t('发布中…', 'Publishing…') : t('发布新版本', 'Publish new version')}
        </button>
      </form>
    </ProjectSettingsPage>
  )
}
