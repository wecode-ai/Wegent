// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import JSZip from 'jszip'

export const DOCX_START = 'DOCX PAGINATION START'
export const DOCX_END = 'DOCX PAGINATION END'

/** Generate public test content with the same floating-shape layout as the bug. */
export async function createPaginationDocx({
  wrapType = 'wrapNone',
  distance = '4294967295',
  positioned = true,
} = {}) {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`
  )
  zip.file(
    '_rels/.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`
  )
  const shape = `<w:p><w:r><w:drawing>
    <wp:anchor distT="${distance}" distB="${distance}" distL="114300" distR="114300"
      simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">
      <wp:simplePos x="0" y="0"/>
      <wp:positionH relativeFrom="column">${positioned ? '<wp:posOffset>0</wp:posOffset>' : '<wp:align>left</wp:align>'}</wp:positionH>
      <wp:positionV relativeFrom="paragraph">${positioned ? '<wp:posOffset>260350</wp:posOffset>' : '<wp:align>top</wp:align>'}</wp:positionV>
      <wp:extent cx="762000" cy="12700"/>
      <wp:effectExtent l="0" t="0" r="0" b="19050"/>
      <wp:${wrapType}${wrapType === 'wrapSquare' ? ' wrapText="bothSides"' : ''}/>
      <wp:docPr id="1" name="Pagination line"/>
      <wp:cNvGraphicFramePr/>
      <a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
        <wps:wsp><wps:cNvSpPr/><wps:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="762000" cy="12700"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="000000"/></a:solidFill>
        </wps:spPr><wps:bodyPr/></wps:wsp>
      </a:graphicData></a:graphic>
    </wp:anchor>
  </w:drawing></w:r></w:p>`
  const paragraph = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
      <w:body>${shape}${paragraph(DOCX_START)}
        ${Array.from({ length: 80 }, (_, index) => paragraph(`DOCX paragraph ${index + 1}: public pagination regression content.`)).join('')}
        ${paragraph(DOCX_END)}
        <w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
          <w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/>
        </w:sectPr>
      </w:body>
    </w:document>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}
