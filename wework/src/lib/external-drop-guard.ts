import { isHttpUrl } from './external-links'

function hasDroppedFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return Array.from(dataTransfer.types).includes('Files') || dataTransfer.files.length > 0
}

function containsDroppedUrl(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types)
  if (types.includes('text/uri-list') || types.includes('URL')) return true
  return isHttpUrl(dataTransfer.getData('text/plain'))
}

function isExternalDrop(dataTransfer: DataTransfer | null): boolean {
  return containsDroppedUrl(dataTransfer) || hasDroppedFiles(dataTransfer)
}

function handleDragOver(event: DragEvent) {
  const { dataTransfer } = event
  if (!dataTransfer || !isExternalDrop(dataTransfer)) return
  event.preventDefault()
  dataTransfer.dropEffect = 'none'
}

function handleDrop(event: DragEvent) {
  if (!isExternalDrop(event.dataTransfer)) return
  event.preventDefault()
}

export function installExternalDropGuard(): () => void {
  window.addEventListener('dragover', handleDragOver, true)
  window.addEventListener('drop', handleDrop, true)
  return () => {
    window.removeEventListener('dragover', handleDragOver, true)
    window.removeEventListener('drop', handleDrop, true)
  }
}
