export const DIAGRAM_REGRESSION_MARKER = 'WEWORK_DIAGRAM_REGRESSION'
const DIAGRAM_SECTION_COUNT = 25
export const DIAGRAM_REGRESSION_LAST_HEADING = `Diagram regression section ${DIAGRAM_SECTION_COUNT - 1}`
// Leave enough content after the diagram that scrolling to the end moves its
// Markdown chunk beyond the 1,600px preparation window at every desktop size.
export const DIAGRAM_REGRESSION_RESPONSE = Array.from(
  { length: DIAGRAM_SECTION_COUNT },
  (_, index) =>
    [
      `## Diagram regression section ${index}`,
      index === 8
        ? '```mermaid\nflowchart TD\nA["保留标签<br/>second line"] --> B[Cached artifact]\nlinkStyle default stroke:#2166cc\n```'
        : Array.from(
            { length: 9 },
            (_, line) =>
              `Section ${index} line ${line}: verify rich transcript windowing and stable reading position.`
          ).join('\n\n'),
    ].join('\n\n')
).join('\n\n')
