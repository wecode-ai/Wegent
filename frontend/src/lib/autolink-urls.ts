/**
 * Autolink URLs pre-processor for Markdown
 *
 * This module provides a function to convert bare URLs in markdown text
 * to proper markdown link format before rendering.
 *
 * This is needed because remark-gfm-safe excludes the autolink literal
 * feature for iOS 16 Safari compatibility (Safari iOS 16 doesn't support
 * lookbehind assertions used in the original implementation).
 *
 * The pre-processor detects bare URLs and converts them to [url](url) format,
 * while preserving:
 * - URLs already in markdown link format: [text](url)
 * - URLs in image format: ![alt](url)
 * - URLs in code blocks: ```code``` or `inline code`
 * - URLs in HTML anchor tags: <a href="url">
 *
 * @see src/lib/remark-gfm-safe.ts
 */

/**
 * Regular expression to match URLs
 * Matches http://, https://, and www. URLs
 */
const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>\[\]()]*[^\s<>\[\]().,;:!?'")\]}>]/gi

/**
 * Check if a position is inside a code block or inline code
 */
function isInsideCode(text: string, position: number): boolean {
  // Check for code blocks (```)
  let inCodeBlock = false
  let i = 0
  while (i < position) {
    if (text.slice(i, i + 3) === '```') {
      inCodeBlock = !inCodeBlock
      i += 3
    } else {
      i++
    }
  }
  if (inCodeBlock) return true

  // Check for inline code (`)
  // Count backticks before position - if odd, we're inside inline code
  const textBefore = text.slice(0, position)
  // Split by escaped backticks and code blocks to only count single backticks
  const withoutCodeBlocks = textBefore.replace(/```[\s\S]*?```/g, '')
  const backtickCount = (withoutCodeBlocks.match(/`/g) || []).length
  return backtickCount % 2 === 1
}

/**
 * Check if a URL at the given position is already part of a markdown link
 * Patterns to skip:
 * - [text](url) - markdown link
 * - ![alt](url) - markdown image
 * - <url> - angle bracket URL (auto-linked by markdown)
 * - <a href="url"> - HTML anchor
 */
function isAlreadyLinked(text: string, urlStart: number, urlEnd: number): boolean {
  // Check if URL is inside parentheses preceded by ] or ![...]
  // This handles both [text](url) and ![alt](url)
  const beforeUrl = text.slice(0, urlStart)

  // Check for markdown link pattern: ](url)
  if (beforeUrl.endsWith('](')) {
    return true
  }

  // Check for markdown link pattern with optional title: ]( url or ]("title" url
  const parenMatch = beforeUrl.match(/\]\(\s*$/)
  if (parenMatch) {
    return true
  }

  // Check if inside angle brackets: <url>
  const lastOpenAngle = beforeUrl.lastIndexOf('<')
  const lastCloseAngle = beforeUrl.lastIndexOf('>')
  if (lastOpenAngle > lastCloseAngle) {
    // We're inside angle brackets, check if the closing > comes after the URL
    const afterUrl = text.slice(urlEnd)
    if (afterUrl.match(/^[^<]*>/)) {
      return true
    }
  }

  // Check if inside href attribute: href="url" or href='url'
  const hrefMatch = beforeUrl.match(/href\s*=\s*["']?$/)
  if (hrefMatch) {
    return true
  }

  // Check if inside src attribute: src="url" or src='url' (for images)
  const srcMatch = beforeUrl.match(/src\s*=\s*["']?$/)
  if (srcMatch) {
    return true
  }

  return false
}

/**
 * Pre-process markdown text to convert bare URLs to markdown link format
 *
 * @param text - The markdown text to process
 * @returns The processed text with bare URLs converted to markdown links
 *
 * @example
 * // Input: "Check out https://example.com for more info"
 * // Output: "Check out [https://example.com](https://example.com) for more info"
 */
export function autolinkUrls(text: string): string {
  if (!text) return text

  const matches: Array<{ start: number; end: number; url: string }> = []

  // Find all URL matches
  let match: RegExpExecArray | null
  while ((match = URL_REGEX.exec(text)) !== null) {
    const url = match[0]
    const start = match.index
    const end = start + url.length

    // Skip if inside code
    if (isInsideCode(text, start)) {
      continue
    }

    // Skip if already linked
    if (isAlreadyLinked(text, start, end)) {
      continue
    }

    matches.push({ start, end, url })
  }

  // Replace matches from end to start to preserve positions
  let result = text
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end, url } = matches[i]
    // Ensure URL has protocol for the href
    const href = url.startsWith('www.') ? `https://${url}` : url
    // Use the original URL as display text, href as the link target
    const markdownLink = `[${url}](${href})`
    result = result.slice(0, start) + markdownLink + result.slice(end)
  }

  return result
}
