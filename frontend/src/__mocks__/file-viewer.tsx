export default function FileViewer({ filename }: { filename?: string }) {
  return <div data-testid="file-viewer-mock">{filename}</div>
}
