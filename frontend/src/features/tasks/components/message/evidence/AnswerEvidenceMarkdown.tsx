'use client'

import { useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { apiClient } from '@/apis/client'
import { getDocument, getDocumentProtection } from '@/apis/knowledge'
import { DocumentDetailDialog } from '@/features/knowledge/document/components/DocumentDetailDialog'
import type { KnowledgeDocument, DocumentProtection } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'

export interface AnswerCitation {
  citation_id: string
  title: string
  knowledge_base_id: number
  document_id: number
}

export interface EvidenceScope {
  answerId?: number
  generationId?: string
  citations?: AnswerCitation[]
  committed: boolean
}

interface Snapshot {
  citation_id: string
  content: string
  title: string
  knowledge_base_id: number
  document_id: number
}

interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
  data?: { hName: string; hProperties: Record<string, string> }
}

// Work on Markdown text nodes before raw HTML is parsed. Code and links are opaque.
export function evidenceRemark(token: string) {
  return (root: unknown) => {
    const tree = root as MarkdownNode
    const walk = (parent: MarkdownNode) => {
      let htmlDepth = 0
      parent.children = (parent.children || []).flatMap((node): MarkdownNode[] => {
        if (node.type === 'html') {
          if (/^<\//.test(node.value || '')) htmlDepth = Math.max(0, htmlDepth - 1)
          else if (
            /^<[a-z][^>]*>$/i.test(node.value || '') &&
            !/^<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i.test(
              node.value || ''
            ) &&
            !/\/>$/.test(node.value || '')
          )
            htmlDepth++
          return [node]
        }
        if (
          htmlDepth ||
          ['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference'].includes(
            node.type
          )
        )
          return [node]
        if (node.type !== 'text') {
          if ('children' in node) walk(node)
          return [node]
        }
        const parts: MarkdownNode[] = []
        const pattern = /\[\[(?:citation:([0-9]+)|evidence:[^\]\n]+|evidence-unavailable)\]\]/g
        let start = 0
        for (const match of (node.value || '').matchAll(pattern)) {
          const offset = match.index!
          parts.push({ type: 'text', value: (node.value || '').slice(start, offset) })
          parts.push({
            type: 'text',
            value: '',
            data: {
              hName: 'answer-citation',
              hProperties: { citationId: match[1] || '', evidenceToken: token },
            },
          })
          start = offset + match[0].length
        }
        parts.push({ type: 'text', value: (node.value || '').slice(start) })
        return parts
      })
    }
    walk(tree)
  }
}

export default function AnswerEvidenceMarkdown({
  evidence,
  ...props
}: ComponentProps<typeof EnhancedMarkdown> & { evidence?: EvidenceScope }) {
  const { user } = useUser()
  const scopeKey = `${user?.id}:${apiClient.getCacheScope()}:${evidence?.answerId}:${evidence?.generationId}:${evidence?.committed}`
  return <EvidenceContent key={scopeKey} {...props} evidence={evidence} />
}

function EvidenceContent({
  evidence,
  ...props
}: ComponentProps<typeof EnhancedMarkdown> & { evidence?: EvidenceScope }) {
  const { t } = useTranslation('chat')
  const [opened, setOpened] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState(false)
  const [originalError, setOriginalError] = useState(false)
  const [original, setOriginal] = useState<{
    document: KnowledgeDocument
    protection: DocumentProtection
  } | null>(null)
  const sequence = useRef(0)
  const scope = apiClient.getCacheScope()
  const current = (request: number) =>
    sequence.current === request && apiClient.getCacheScope() === scope

  const open = async (citationId: string) => {
    const request = ++sequence.current
    setOpened(true)
    setSnapshot(null)
    setError(false)
    setOriginal(null)
    setOriginalError(false)
    try {
      const data = await apiClient.get<Snapshot>(
        `/knowledge-bases/citations/${citationId}?answer_id=${evidence!.answerId}&generation_id=${evidence!.generationId}`,
        { cache: 'no-store' }
      )
      if (current(request)) setSnapshot(data)
    } catch {
      if (current(request)) setError(true)
    }
  }

  const openOriginal = async () => {
    if (!snapshot) return
    const request = sequence.current
    setOriginalError(false)
    try {
      const [document, protection] = await Promise.all([
        getDocument(snapshot.document_id),
        getDocumentProtection(snapshot.knowledge_base_id),
      ])
      if (document.kind_id !== snapshot.knowledge_base_id) throw new Error('Document moved')
      if (current(request)) setOriginal({ document, protection })
    } catch {
      if (current(request)) setOriginalError(true)
    }
  }

  const [token] = useState(() => Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'))
  const remarkPlugins = useMemo(() => [() => evidenceRemark(token)], [token])
  return (
    <>
      <EnhancedMarkdown
        {...props}
        remarkPlugins={remarkPlugins}
        components={{
          ...props.components,
          'answer-citation': ({
            citationId,
            evidenceToken,
          }: {
            citationId?: string
            evidenceToken?: string
          }) => {
            const citation = evidence?.citations?.find(item => item.citation_id === citationId)
            return evidenceToken === token &&
              evidence?.committed &&
              evidence.answerId &&
              evidence.generationId &&
              citation ? (
              <button
                type="button"
                data-testid={`answer-citation-${citationId}`}
                className="mx-1 min-h-11 min-w-11 text-primary underline"
                onClick={() => void open(citation.citation_id)}
              >
                {citation.title}
              </button>
            ) : (
              <span data-testid="answer-evidence-unavailable" className="text-text-muted">
                {t('evidence.unavailable')}
              </span>
            )
          },
        }}
      />
      {opened && (
        <section
          role="dialog"
          aria-label={t('evidence.title')}
          data-testid="answer-evidence-panel"
          className="my-3 rounded-lg border border-border bg-surface p-4"
        >
          <div className="flex justify-between gap-3">
            <strong>{t('evidence.title')}</strong>
            <button
              type="button"
              className="min-h-11 min-w-11"
              data-testid="answer-evidence-close"
              onClick={() => {
                sequence.current++
                setOpened(false)
                setSnapshot(null)
                setOriginal(null)
              }}
            >
              {t('evidence.close')}
            </button>
          </div>
          {error ? (
            <p role="alert">{t('evidence.read_failed')}</p>
          ) : snapshot ? (
            <>
              <p className="whitespace-pre-wrap" data-testid="answer-evidence-content">
                {snapshot.content}
              </p>
              <button
                type="button"
                className="min-h-11 min-w-11"
                data-testid="answer-evidence-open-original"
                onClick={() => void openOriginal()}
              >
                {t('evidence.open_original')}
              </button>
            </>
          ) : (
            <p>{t('evidence.loading')}</p>
          )}
          {originalError && <p role="alert">{t('evidence.original_failed')}</p>}
        </section>
      )}
      {original && snapshot && (
        <DocumentDetailDialog
          open
          onOpenChange={value => {
            if (!value) setOriginal(null)
          }}
          document={original.document}
          knowledgeBaseId={snapshot.knowledge_base_id}
          allowDownload={original.protection.original_download_allowed === true}
          watermarkText={original.protection.watermark_text}
        />
      )}
    </>
  )
}
