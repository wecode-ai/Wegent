import JSZip from 'jszip'
import { expect, test } from 'vitest'
import { safeOfficePreviewFile } from './safe-office-preview'

async function fixture(target: string, part = 'word/_rels/document.xml.rels', type = 'hyperlink') {
  const zip = new JSZip()
  zip.file(
    part,
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}" TargetMode="External"/></Relationships>`
  )
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  const file = new File([bytes], 'document.docx')
  file.arrayBuffer = async () => bytes
  return { file, part }
}

test.each([
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'java&#10;script:alert(1)',
  'data:text/html,script',
  'file:///private/credential',
])('neutralizes dangerous DOCX relationship %s before rendering', async target => {
  const { file, part } = await fixture(target)
  const safe = await safeOfficePreviewFile(file)
  expect(safe).not.toBe(file)
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = reject
    reader.readAsArrayBuffer(safe)
  })
  const result = await (await JSZip.loadAsync(bytes)).file(part)!.async('string')
  expect(result).toContain('Target="#"')
  expect(result).toContain('rId1')
})

test.each(['https://example.test/document', 'http://example.test/document'])(
  'preserves safe DOCX links %s',
  async target => {
    const { file } = await fixture(target)
    expect(await safeOfficePreviewFile(file)).toBe(file)
  }
)

test('rejects malformed relationship XML before preview dispatch', async () => {
  const { file } = await fixture('bad"broken')
  await expect(safeOfficePreviewFile(file)).rejects.toThrow(/Invalid Office/)
})

test.each(['image', 'custom'])(
  'neutralizes a forged %s relationship in a document header',
  async type => {
    const { file } = await fixture('javascript:alert(1)', 'word/_rels/header1.xml.rels', type)
    expect(await safeOfficePreviewFile(file)).not.toBe(file)
  }
)

test('secures documents selected by MIME type even with a different filename extension', async () => {
  const { file } = await fixture('javascript:alert(1)')
  const source = new File([await file.arrayBuffer()], 'report.bin', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  source.arrayBuffer = file.arrayBuffer
  expect(await safeOfficePreviewFile(source)).not.toBe(source)
})
