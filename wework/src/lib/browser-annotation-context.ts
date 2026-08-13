import type {
  BrowserAnnotationScope,
  BrowserAnnotationTargetSnapshot,
  PageAnnotationDto,
} from '@/types/browser-annotation'
import type { CodeCommentContext } from '@/types/workspace-files'

export function isBrowserAnnotationContext(context: CodeCommentContext): boolean {
  return context.source === 'browser_annotation' || context.filePath.startsWith('browser:')
}

export function browserAnnotationScopeKey(scope: BrowserAnnotationScope): string {
  return `${scope.browserTabId}:${scope.pageSessionId}`
}

export function hasBrowserAnnotationScope(
  context: CodeCommentContext,
  scope: BrowserAnnotationScope
): boolean {
  const contextScope = context.browserAnnotation?.scope
  return Boolean(
    contextScope &&
    contextScope.browserTabId === scope.browserTabId &&
    contextScope.pageSessionId === scope.pageSessionId
  )
}

export function browserContextsForTab(
  contexts: CodeCommentContext[],
  browserTabId: string
): CodeCommentContext[] {
  return contexts.filter(
    context =>
      isBrowserAnnotationContext(context) &&
      context.browserAnnotation?.scope.browserTabId === browserTabId
  )
}

export function browserSnapshotToContexts(
  snapshot: BrowserAnnotationSnapshotInput,
  title: string | null
): CodeCommentContext[] {
  return snapshot.annotations.map(annotation =>
    browserAnnotationToContext(annotation, snapshot.scope, title)
  )
}

interface BrowserAnnotationSnapshotInput {
  scope: BrowserAnnotationScope
  annotations: PageAnnotationDto[]
}

export function browserAnnotationToContext(
  annotation: PageAnnotationDto,
  scope: BrowserAnnotationScope,
  title: string | null
): CodeCommentContext {
  const target = annotation.target
  return {
    id: annotation.id,
    source: 'browser_annotation',
    filePath: `browser:${scope.url}`,
    fileName: title || browserTitle(scope.url),
    startLine: annotation.number,
    endLine: annotation.number,
    selectedText: JSON.stringify(browserSelectedText(target, scope), null, 2),
    comment: annotation.comment,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    browserAnnotation: {
      scope,
      number: annotation.number,
      target,
    },
    adjustments: annotation.adjustments.length > 0 ? annotation.adjustments : undefined,
  }
}

function browserSelectedText(
  target: BrowserAnnotationTargetSnapshot,
  scope: BrowserAnnotationScope
): Record<string, unknown> {
  return {
    type: 'browser_annotation',
    url: scope.url,
    rect: target.rect,
    inspectId: target.inspectId,
    target,
    matchConfidence: target.matchConfidence,
  }
}

function browserTitle(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}
