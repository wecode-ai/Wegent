export const DIAGRAM_PREVIEW_HEIGHT_REM = 24
export const DIAGRAM_PREVIEW_MARGIN_REM = 1.25

export type DiagramKind = 'mermaid' | 'plantuml'

export function diagramKind(language: string): DiagramKind | null {
  switch (language.toLowerCase()) {
    case 'mermaid':
    case 'mmd':
      return 'mermaid'
    case 'plantuml':
    case 'puml':
      return 'plantuml'
    default:
      return null
  }
}

export function diagramPreviewHeight(rootFontSize: number): number {
  return (DIAGRAM_PREVIEW_HEIGHT_REM + DIAGRAM_PREVIEW_MARGIN_REM) * rootFontSize
}
