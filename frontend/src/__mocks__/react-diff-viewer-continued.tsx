// Mock for react-diff-viewer-continued to avoid ESM issues in Jest
interface ReactDiffViewerProps {
  oldValue?: string
  newValue?: string
  splitView?: boolean
  showDiffOnly?: boolean
  styles?: Record<string, unknown>
}

export default function ReactDiffViewer({ oldValue = '', newValue = '' }: ReactDiffViewerProps) {
  return (
    <div data-testid="react-diff-viewer-mock">
      <div data-testid="old-value">{oldValue}</div>
      <div data-testid="new-value">{newValue}</div>
    </div>
  )
}
