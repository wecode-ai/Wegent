// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { jsPDF } from 'jspdf'

function createPdf(): Buffer {
  const pdf = new jsPDF({ compress: false })
  for (let page = 1; page <= 3; page += 1) {
    if (page > 1) pdf.addPage()
    pdf.text(`DINGTALK PDF PAGE ${page}`, 20, 20)
    if (page === 2) {
      // A real uncompressed image puts the xref beyond PDF.js's initial 64 KiB
      // chunk without adding dozens of pages/thumbnails to the renderer workload.
      const data = new Uint8ClampedArray(512 * 512 * 4)
      for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = (offset / 4) % 256
        data[offset + 1] = Math.floor(offset / 2048) % 256
        data[offset + 2] = 128
        data[offset + 3] = 255
      }
      pdf.addImage({ data, width: 512, height: 512 }, 'RGBA', 20, 40, 100, 100)
    }
  }
  return Buffer.from(pdf.output('arraybuffer'))
}

/** Valid source files, generated on disk rather than browser response substitutions. */
export async function writePreviewFiles(directory: string): Promise<void> {
  await writeFile(join(directory, 'preview.pdf'), createPdf())

  const docx = new JSZip()
  docx.file(
    '[Content_Types].xml',
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`
  )
  docx.file(
    '_rels/.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`
  )
  docx.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>DINGTALK OFFICE PREVIEW CONTENT</w:t></w:r></w:p>
        <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
      </w:body>
    </w:document>`
  )
  await writeFile(join(directory, 'preview.docx'), await docx.generateAsync({ type: 'nodebuffer' }))
}
