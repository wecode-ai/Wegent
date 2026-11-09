import JSZip from 'jszip'
import { isHttpUrl } from '@wegent/chat-core/http-url'

export function isDocxPreviewFile(file: Pick<File, 'name' | 'type'>): boolean {
  return (
    /\.docx$/i.test(file.name) ||
    file.type.split(';', 1)[0].trim().toLowerCase() ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
}

/** Validate document relationships before the third-party renderer can create live anchors. */
export async function safeOfficePreviewFile(file: File): Promise<File> {
  if (!isDocxPreviewFile(file)) return file
  const archive = await JSZip.loadAsync(await file.arrayBuffer())
  let changed = false
  for (const part of Object.values(archive.files)) {
    if (part.dir || !/\.rels$/i.test(part.name)) continue
    const source = await part.async('string')
    const document = new DOMParser().parseFromString(source, 'application/xml')
    if (
      document.getElementsByTagName('parsererror').length ||
      document.documentElement.localName !== 'Relationships' ||
      Array.from(document.documentElement.children).some(part => part.localName !== 'Relationship')
    ) {
      throw new Error('Invalid Office document relationships')
    }
    let partChanged = false
    // The renderer resolves hyperlink IDs without checking the relationship type.
    for (const relationship of Array.from(document.documentElement.children)) {
      if (relationship.getAttribute('TargetMode') !== 'External') continue
      const target = relationship.getAttribute('Target') ?? ''
      if (isHttpUrl(target)) continue
      relationship.setAttribute('Target', '#')
      partChanged = true
    }
    if (!partChanged) continue
    archive.file(part.name, new XMLSerializer().serializeToString(document))
    changed = true
  }
  if (!changed) return file
  const bytes = await archive.generateAsync({ type: 'arraybuffer' })
  return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified })
}
