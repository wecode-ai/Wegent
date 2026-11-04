export const DIAGRAM_REGRESSION_MARKER = 'WEWORK_DIAGRAM_REGRESSION'
export const DIAGRAM_REGRESSION_RESPONSE = Array.from({ length: 17 }, (_, index) =>
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
