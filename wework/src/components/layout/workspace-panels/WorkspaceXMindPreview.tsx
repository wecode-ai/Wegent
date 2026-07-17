import JSZip from 'jszip'
import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface XMindTopic {
  children: XMindTopic[]
  title: string
}

interface XMindSheet {
  root: XMindTopic
  title: string
}

interface WorkspaceXMindPreviewProps {
  file: File
  name: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseJsonTopic(value: unknown): XMindTopic | null {
  const topic = asRecord(value)
  if (!topic) return null
  const children = asRecord(topic.children)
  const attached = Array.isArray(children?.attached) ? children.attached : []
  return {
    children: attached.map(parseJsonTopic).filter((child): child is XMindTopic => Boolean(child)),
    title: typeof topic.title === 'string' ? topic.title : '',
  }
}

function findDirectChild(element: Element, name: string): Element | null {
  return Array.from(element.children).find(child => child.localName === name) ?? null
}

function parseXmlTopic(element: Element): XMindTopic {
  const children = findDirectChild(element, 'children')
  const topics = children
    ? Array.from(children.querySelectorAll(':scope > topics > topic')).map(parseXmlTopic)
    : []
  return {
    children: topics,
    title: findDirectChild(element, 'title')?.textContent?.trim() ?? '',
  }
}

function parseXMind8(content: string): XMindSheet[] {
  const document = new DOMParser().parseFromString(content, 'application/xml')
  if (document.querySelector('parsererror')) return []
  return Array.from(document.documentElement.querySelectorAll(':scope > sheet')).flatMap(sheet => {
    const root = findDirectChild(sheet, 'topic')
    return root
      ? [
          {
            root: parseXmlTopic(root),
            title: findDirectChild(sheet, 'title')?.textContent?.trim() ?? '',
          },
        ]
      : []
  })
}

async function parseXMind(file: File): Promise<XMindSheet[]> {
  const archive = await JSZip.loadAsync(await file.arrayBuffer())
  const json = archive.file('content.json')
  if (json) {
    const content = JSON.parse(await json.async('text'))
    if (!Array.isArray(content)) return []
    return content.flatMap(sheet => {
      const record = asRecord(sheet)
      const root = parseJsonTopic(record?.rootTopic)
      return root ? [{ root, title: typeof record?.title === 'string' ? record.title : '' }] : []
    })
  }

  const xml = archive.file('content.xml')
  return xml ? parseXMind8(await xml.async('text')) : []
}

function XMindTopicTree({ topic }: { topic: XMindTopic }) {
  return (
    <li className="min-w-0">
      <p className="rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary">
        {topic.title || '—'}
      </p>
      {topic.children.length > 0 && (
        <ul className="ml-4 mt-2 space-y-2 border-l border-border pl-3">
          {topic.children.map((child, index) => (
            <XMindTopicTree key={`${child.title}:${index}`} topic={child} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function WorkspaceXMindPreview({ file, name }: WorkspaceXMindPreviewProps) {
  const { t } = useTranslation('common')
  const [sheets, setSheets] = useState<XMindSheet[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void parseXMind(file)
      .then(parsed => {
        if (cancelled) return
        if (parsed.length === 0) throw new Error(t('workbench.workspace_file_preview_failed'))
        setSheets(parsed)
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [file, t])

  if (error) {
    return <p className="p-6 text-sm text-red-500">{error}</p>
  }

  if (!sheets) {
    return (
      <p className="p-6 text-sm text-text-secondary">
        {t('workbench.workspace_file_preview_loading')}
      </p>
    )
  }

  return (
    <section
      data-testid="workspace-xmind-file-preview"
      className="min-w-0 flex-1 overflow-auto bg-surface p-5"
    >
      <h2 className="mb-4 truncate text-lg font-semibold text-text-primary">{name}</h2>
      <div className="space-y-6">
        {sheets.map((sheet, index) => (
          <section key={`${sheet.title}:${index}`}>
            {sheet.title && (
              <h3 className="mb-2 text-sm font-medium text-text-secondary">{sheet.title}</h3>
            )}
            <ul className="space-y-2">
              <XMindTopicTree topic={sheet.root} />
            </ul>
          </section>
        ))}
      </div>
    </section>
  )
}
