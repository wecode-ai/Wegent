// Host integration tests use the same lightweight Markdown boundary as other Web tests.
// The real streaming parser, tables, code and diagram interactions run in Vitest.
export { default as Streamdown } from './react-markdown'
export const defaultRehypePlugins = {}
