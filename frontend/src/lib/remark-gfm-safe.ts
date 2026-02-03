/**
 * Custom remark-gfm plugin that excludes autolink literals
 *
 * This is a Safari iOS 16 compatible version of remark-gfm.
 * The original remark-gfm uses lookbehind assertions in its autolink literal regex:
 *   /(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu
 *
 * Safari on iOS 16 does not support lookbehind assertions, causing:
 *   SyntaxError: Invalid regular expression: invalid group specifier name
 *
 * This plugin provides all GFM features EXCEPT autolink literals:
 * - Tables
 * - Strikethrough
 * - Task lists
 * - Footnotes
 * - Autolink literals (disabled for iOS 16 compatibility)
 *
 * @see https://github.com/remarkjs/remark-gfm
 * @see https://github.com/micromark/micromark-extension-gfm
 */

import { combineExtensions } from 'micromark-util-combine-extensions'
// Import individual GFM extensions (excluding autolink-literal)
import { gfmFootnote } from 'micromark-extension-gfm-footnote'
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough'
import { gfmTable } from 'micromark-extension-gfm-table'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'
// Import mdast utilities (excluding autolink-literal)
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from 'mdast-util-gfm-footnote'
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough'
import { gfmTableFromMarkdown, gfmTableToMarkdown } from 'mdast-util-gfm-table'
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from 'mdast-util-gfm-task-list-item'

export interface RemarkGfmSafeOptions {
  /**
   * Whether to support strikethrough with a single tilde.
   * Single tildes work on github.com but are technically prohibited by GFM.
   * @default true
   */
  singleTilde?: boolean
}

/**
 * Create a micromark extension for GFM syntax (without autolink literals).
 */
function gfmSafe(options?: RemarkGfmSafeOptions) {
  return combineExtensions([
    // gfmAutolinkLiteral() - EXCLUDED for iOS 16 compatibility
    gfmFootnote(),
    gfmStrikethrough(options),
    gfmTable(),
    gfmTaskListItem(),
  ])
}

/**
 * Create mdast extension for parsing GFM (without autolink literals).
 */
function gfmFromMarkdownSafe() {
  return [
    // gfmAutolinkLiteralFromMarkdown() - EXCLUDED for iOS 16 compatibility
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ]
}

/**
 * Create mdast extension for serializing GFM (without autolink literals).
 */
function gfmToMarkdownSafe(options?: RemarkGfmSafeOptions) {
  return {
    extensions: [
      // gfmAutolinkLiteralToMarkdown() - EXCLUDED for iOS 16 compatibility
      gfmFootnoteToMarkdown(),
      gfmStrikethroughToMarkdown(),
      gfmTableToMarkdown(options as Parameters<typeof gfmTableToMarkdown>[0]),
      gfmTaskListItemToMarkdown(),
    ],
  }
}

/**
 * Remark plugin to add GFM support (without autolink literals).
 *
 * This is a drop-in replacement for remark-gfm that is compatible with
 * Safari on iOS 16 and other browsers that don't support lookbehind assertions.
 *
 * @example
 * ```tsx
 * import ReactMarkdown from 'react-markdown'
 * import remarkGfmSafe from '@/lib/remark-gfm-safe'
 *
 * <ReactMarkdown remarkPlugins={[remarkGfmSafe]}>
 *   {markdown}
 * </ReactMarkdown>
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function remarkGfmSafe(this: any, options?: RemarkGfmSafeOptions) {
  const data = this.data()

  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = [])
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = [])
  const toMarkdownExtensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = [])

  micromarkExtensions.push(gfmSafe(options))
  fromMarkdownExtensions.push(gfmFromMarkdownSafe())
  toMarkdownExtensions.push(gfmToMarkdownSafe(options))
}
