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

/** Create external links with valid OOXML IDs, including forged relationship types. */
export async function createLinkedDocumentFixture(path, links) {
  const xml = value =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('\n', '&#10;')
  await createOfficePackage(
    path,
    'word/document.xml',
    {
      'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${OFFICE_RELATIONSHIPS}"><w:body>${links.map((link, index) => `<w:p><w:hyperlink r:id="rId${index}"><w:r><w:t>${xml(link.label)}</w:t></w:r></w:hyperlink></w:p>`).join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
      'word/_rels/document.xml.rels': `<Relationships xmlns="${RELATIONSHIPS}">${links.map((link, index) => `<Relationship Id="rId${index}" Type="${OFFICE_RELATIONSHIPS}/${xml(link.type ?? 'hyperlink')}" TargetMode="External" Target="${xml(link.target)}"/>`).join('')}</Relationships>`,
    },
    { 'word/document.xml': 'wordprocessingml.document.main+xml' }
  )
}
