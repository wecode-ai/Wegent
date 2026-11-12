import type { SYNTAX_COLOR_NAMES } from './themeCatalogue'

type SyntaxColorName = (typeof SYNTAX_COLOR_NAMES)[number]

/** Pierre syntax categories share the workbench palette in Markdown, files and diffs. */
const syntaxCategories: Record<SyntaxColorName, string[]> = {
  keyword: [
    'keyword',
    'keyword.control',
    'keyword.declaration',
    'keyword.import',
    'keyword.jsdoc',
    'preproc',
  ],
  string: [
    'string',
    'string.escape',
    'string.regex',
    'string.special',
    'string.special.symbol',
    'text.literal',
    'text.jsx',
  ],
  comment: ['comment', 'comment.doc', 'hint', 'predictive'],
  number: ['number', 'boolean', 'constant', 'constant.builtin', 'enum', 'variant'],
  function: ['function', 'function.definition', 'function.method', 'constructor', 'title'],
  type: [
    'type',
    'type.builtin',
    'type.class',
    'type.jsdoc',
    'namespace',
    'tag',
    'tag.doctype',
    'tag.jsx',
    'tag.component.jsx',
  ],
  variable: [
    'variable',
    'variable.parameter',
    'variable.special',
    'variable.jsdoc',
    'property',
    'property.json_key',
    'attribute',
    'attribute.jsx',
    'selector',
    'selector.class',
    'selector.id',
    'selector.pseudo',
    'label',
  ],
  operator: ['operator', 'keyword.operator'],
  punctuation: [
    'punctuation',
    'punctuation.bracket',
    'punctuation.bracket.html',
    'punctuation.bracket.jsx',
    'punctuation.delimiter',
    'punctuation.delimiter.html',
    'punctuation.delimiter.jsx',
    'punctuation.list_marker',
    'punctuation.markup',
    'punctuation.special',
  ],
}

export const PIERRE_SYNTAX_COLORS = Object.fromEntries(
  Object.entries(syntaxCategories).flatMap(([color, categories]) =>
    categories.map(category => [category, color])
  )
) as Record<string, SyntaxColorName>
