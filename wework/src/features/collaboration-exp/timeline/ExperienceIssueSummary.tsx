import { useMemo } from 'react'
import { ArrowRight, FolderKanban } from 'lucide-react'
import { IssueActivityMarkdown } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperienceIssueData } from '../data/useExperienceIssue'
import { projectScopeOf, type ExperienceProjectScope } from '../model'
import { ExperienceDialog } from '../shell/ExperienceDialog'
import { issueSummaryContent } from './issueSummaryContent'
import './ExperienceIssueSummary.css'

interface Props {
  data: ExperienceIssueData
  onClose(): void
  onConfigure(): void
  onProject(project: ExperienceProjectScope): void
}

export function ExperienceIssueSummary({ data, onClose, onConfigure, onProject }: Props) {
  const { t } = useTranslation('collaborationExp')
  const { issue, project } = data
  const content = useMemo(() => issueSummaryContent(issue.description), [issue.description])
  const security = issue.security_level ?? project.default_issue_security
  const visibility = t(`detailsSummary.visibility.${security ?? 'unknown'}`)
  const status =
    project.board_config?.statuses.find(row => row.id === issue.status)?.name ?? issue.status
  return (
    <ExperienceDialog
      testId="collaboration-exp-issue-summary"
      title={t('timeline.details')}
      subtitle={issue.title}
      closeLabel={t('detailsSummary.close')}
      onClose={onClose}
    >
      <div className="experience-issue-summary">
        {content.description ? <IssueActivityMarkdown content={content.description} /> : null}
        <p data-testid="collaboration-exp-issue-summary-visibility">
          {t('detailsSummary.visibilityLabel', { value: visibility })}
        </p>
        <p data-testid="collaboration-exp-issue-summary-status">
          {t('detailsSummary.status', { value: status })}
        </p>
        <button
          type="button"
          className="experience-summary-link"
          data-testid="collaboration-exp-issue-summary-configure"
          onClick={onConfigure}
        >
          {t('detailsSummary.configure')} <ArrowRight size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="experience-summary-link"
          data-testid="collaboration-exp-issue-summary-project"
          onClick={() => onProject(projectScopeOf(project))}
        >
          <FolderKanban size={16} aria-hidden="true" /> {project.name}
        </button>
        {content.acceptance ? (
          <section data-testid="collaboration-exp-issue-summary-acceptance">
            <h3>{t('detailsSummary.acceptance')}</h3>
            <IssueActivityMarkdown content={content.acceptance} />
          </section>
        ) : null}
      </div>
    </ExperienceDialog>
  )
}
