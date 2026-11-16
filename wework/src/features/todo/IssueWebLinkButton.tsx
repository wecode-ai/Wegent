import { useContext, useState } from 'react'
import { Check, Link } from 'lucide-react'
import type { CloudProject } from '@/api/deliveries'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'

export function IssueWebLinkButton({
  project,
  issueId,
}: {
  project?: CloudProject
  issueId: string
}) {
  const cloud = useContext(CloudConnectionContext)
  const { t } = useTranslation('common')
  const [result, setResult] = useState<'copied' | 'failed' | null>(null)
  const [copying, setCopying] = useState(false)
  if (project?.project_store !== 'backend' || !cloud?.webUrl) return null

  const base = cloud.webUrl.replace(/\/+$/, '')
  const projectPath = project.workspace_id
    ? `/collaboration/workspaces/${encodeURIComponent(project.workspace_id)}/projects/${encodeURIComponent(project.id)}`
    : `/collaboration/${encodeURIComponent(project.id)}`
  const url = `${base}${projectPath}/issues/${encodeURIComponent(issueId)}`
  const label =
    result === 'copied'
      ? t('todo.copied', '已复制')
      : result === 'failed'
        ? t('todo.copy_web_link_failed', '复制失败，请重试')
        : t('todo.copy_web_link', '复制网页链接')

  return (
    <button
      type="button"
      data-testid="issue-copy-web-link"
      aria-label={label}
      title={label}
      disabled={copying}
      className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition hover:bg-muted hover:text-text-primary disabled:opacity-50"
      onMouseLeave={() => setResult(null)}
      onBlur={() => setResult(null)}
      onClick={async () => {
        setCopying(true)
        try {
          await copyTextToClipboard(url)
          setResult('copied')
        } catch {
          setResult('failed')
        } finally {
          setCopying(false)
        }
      }}
    >
      {result === 'copied' ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Link className="h-4 w-4" aria-hidden="true" />
      )}
      <span className="sr-only" role="status">
        {result ? label : ''}
      </span>
    </button>
  )
}
