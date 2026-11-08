import type { StandInMemory } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInMemoryEvidence({ memory }: { memory: StandInMemory }) {
  const { t } = useTranslation('common')
  const evidence = memory.evidence
  if (!evidence?.excerpt) return null
  const record = evidence.source
  const projectSource = record?.projectId
    ? [
        t(
          record.projectStore === 'local'
            ? 'standIn.memory.source_local_project'
            : record.projectStore === 'cloud'
              ? 'standIn.memory.source_cloud_project'
              : 'standIn.memory.source_project',
          { id: record.projectId }
        ),
        record.itemId && t('standIn.memory.source_issue', { id: record.itemId }),
        record.deliveryId && t('standIn.memory.source_delivery', { id: record.deliveryId }),
        record.assetId && t('standIn.memory.source_asset', { id: record.assetId }),
        record.attachmentId && t('standIn.memory.source_attachment', { id: record.attachmentId }),
        record.fileId && t('standIn.memory.source_file', { id: record.fileId }),
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined
  const source = projectSource ?? record?.name ?? record?.id ?? evidence.taskId
  const speaker =
    evidence.kind === 'image_observation'
      ? t('standIn.memory.evidence_image_observation')
      : evidence.role === 'user'
        ? t('standIn.memory.evidence_user')
        : evidence.role === 'assistant'
          ? t('standIn.memory.evidence_assistant')
          : t('standIn.memory.evidence_source')
  return (
    <details className="mt-2 text-sm" data-testid="stand-in-memory-evidence">
      <summary
        className="min-h-11 cursor-pointer py-2 text-text-secondary md:min-h-8 md:py-1"
        data-testid="stand-in-memory-evidence-toggle"
      >
        {t('standIn.memory.evidence')}
      </summary>
      <p className="break-words text-xs text-text-muted">
        {speaker}
        {source ? ` · ${source}` : ''}
      </p>
      {evidence.kind === 'image_observation' ? (
        <p className="mt-2 whitespace-pre-wrap break-words">{evidence.excerpt}</p>
      ) : (
        <blockquote className="mt-2 whitespace-pre-wrap break-words border-l border-border pl-3">
          {evidence.excerpt}
        </blockquote>
      )}
    </details>
  )
}
