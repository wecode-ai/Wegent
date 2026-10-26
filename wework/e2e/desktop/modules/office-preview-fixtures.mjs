import { join } from 'node:path'
import { createZipFixture } from './zip-fixtures.mjs'

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CONTENT_TYPES = 'application/vnd.openxmlformats-officedocument.'

function relationships(entries) {
  return `<Relationships xmlns="${RELATIONSHIPS}">${entries
    .map(
      ([id, type, target]) =>
        `<Relationship Id="rId${id}" Type="${OFFICE_RELATIONSHIPS}/${type}" Target="${target}"/>`
    )
    .join('')}</Relationships>`
}

async function createOfficePackage(path, main, files, types) {
  await createZipFixture(path, {
    '_rels/.rels': relationships([[1, 'officeDocument', main]]),
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      ${Object.entries(types)
        .map(
          ([part, type]) => `<Override PartName="/${part}" ContentType="${CONTENT_TYPES}${type}"/>`
        )
        .join('')}
    </Types>`,
    ...files,
  })
}

async function createPresentation(path, pageCount = 8) {
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1)
  const files = {
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OFFICE_RELATIONSHIPS}">
      <p:sldIdLst>${pages.map(page => `<p:sldId id="${255 + page}" r:id="rId${page}"/>`).join('')}</p:sldIdLst>
      <p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/>
    </p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relationships(
      pages.map(page => [page, 'slide', `slides/slide${page}.xml`])
    ),
  }
  const types = { 'ppt/presentation.xml': 'presentationml.presentation.main+xml' }
  for (const page of pages) {
    const part = `ppt/slides/slide${page}.xml`
    files[part] =
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree>
        <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
        <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="1371600"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
          <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"/>
            <a:t>PPT PAGE ${page} OF ${pageCount}</a:t></a:r></a:p></p:txBody>
        </p:sp>
      </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
    </p:sld>`
    types[part] = 'presentationml.slide+xml'
  }
  await createOfficePackage(path, 'ppt/presentation.xml', files, types)
}

async function createDocument(path) {
  const paragraphs = Array.from(
    { length: 180 },
    (_, index) =>
      `<w:p><w:r><w:t>WORD PARAGRAPH ${String(index + 1).padStart(3, '0')} - scrolling verification.</w:t></w:r></w:p>`
  ).join('')
  await createOfficePackage(
    path,
    'word/document.xml',
    {
      'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>
          <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
        </w:sectPr></w:body>
      </w:document>`,
    },
    { 'word/document.xml': 'wordprocessingml.document.main+xml' }
  )
}

async function createWorkbook(path) {
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const names = ['Data', 'Summary']
  const files = {
    'xl/workbook.xml': `<workbook xmlns="${namespace}" xmlns:r="${OFFICE_RELATIONSHIPS}"><sheets>
      ${names.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}
    </sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships(
      names.map((_, index) => [index + 1, 'worksheet', `worksheets/sheet${index + 1}.xml`])
    ),
  }
  const types = { 'xl/workbook.xml': 'spreadsheetml.sheet.main+xml' }
  for (const [index, name] of names.entries()) {
    const rows = Array.from({ length: 120 }, (_, row) => {
      const cells = Array.from({ length: 24 }, (_, column) => {
        const cell = `${String.fromCharCode(65 + column)}${row + 1}`
        return `<c r="${cell}" t="inlineStr"><is><t>${name.toUpperCase()} R${row + 1} C${column + 1}</t></is></c>`
      }).join('')
      return `<row r="${row + 1}">${cells}</row>`
    }).join('')
    const part = `xl/worksheets/sheet${index + 1}.xml`
    files[part] =
      `<worksheet xmlns="${namespace}"><dimension ref="A1:X120"/><sheetData>${rows}</sheetData></worksheet>`
    types[part] = 'spreadsheetml.worksheet+xml'
  }
  await createOfficePackage(path, 'xl/workbook.xml', files, types)
}

export async function createOfficePreviewFixtures(directory) {
  await createPresentation(join(directory, 'slides.pptx'))
  await createPresentation(join(directory, 'long-slides.pptx'), 32)
  await createDocument(join(directory, 'document.docx'))
  await createWorkbook(join(directory, 'workbook.xlsx'))
}
