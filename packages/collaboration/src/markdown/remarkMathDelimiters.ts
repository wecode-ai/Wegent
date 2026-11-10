import type { Nodes, Root } from 'mdast'
import type { InlineMath } from 'mdast-util-math'
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown'
import type { Code, Construct, Extension, State, Tokenizer } from 'micromark-util-types'
import { unified, type Plugin } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { math } from '@streamdown/math'

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    assistantMath: 'assistantMath'
    assistantMathMarker: 'assistantMathMarker'
    assistantMathValue: 'assistantMathValue'
  }
}

const isSpace = (code: Code) => code !== null && (code < 0 || code === 32 || code === 9)
const isDigit = (code: Code) => code !== null && code >= 48 && code <= 57
const isLineEnding = (code: Code) => code !== null && code < -2

/**
 * Parses TeX delimiters before CommonMark consumes backslash escapes. Code,
 * escaped delimiters, and link destinations retain the Markdown parser's rules.
 */
function mathConstruct(open: number, close: number, flow = false): Construct {
  const dollar = open === 36
  const tokenize: Tokenizer = function (effects, ok, nok) {
    let previous: Code = null
    const marker = () => effects.enter('assistantMathMarker')
    const closing: Construct = {
      tokenize(checkEffects, checkOk, checkNok) {
        return slash
        function slash(code: Code): State | undefined {
          checkEffects.enter('assistantMathMarker')
          checkEffects.consume(code)
          return end
        }
        function end(code: Code): State | undefined {
          if (code !== close) return checkNok(code)
          checkEffects.consume(code)
          checkEffects.exit('assistantMathMarker')
          return checkOk
        }
      },
    }
    return start

    function start(code: Code): State | undefined {
      effects.enter('assistantMath')
      marker()
      effects.consume(code)
      return dollar ? afterOpen : openingBracket
    }

    function openingBracket(code: Code): State | undefined {
      if (code !== open) return nok(code)
      effects.consume(code)
      return afterOpen
    }

    function afterOpen(code: Code): State | undefined {
      if (dollar && (code === 36 || code === null || isSpace(code))) return nok(code)
      effects.exit('assistantMathMarker')
      return between(code)
    }

    function between(code: Code): State | undefined {
      if (code === null || (dollar && isLineEnding(code))) return nok(code)
      if (isLineEnding(code)) {
        effects.enter('lineEnding')
        effects.consume(code)
        effects.exit('lineEnding')
        return between
      }
      if (code === 92) {
        return dollar ? escapeSlash(code) : effects.check(closing, closeSlash, escapeSlash)(code)
      }
      if (dollar && code === 36) {
        if (isSpace(previous)) return nok(code)
        marker()
        effects.consume(code)
        return afterClose
      }
      effects.enter('assistantMathValue')
      return value(code)
    }

    function value(code: Code): State | undefined {
      if (code === null || isLineEnding(code) || code === 92 || (dollar && code === 36)) {
        effects.exit('assistantMathValue')
        return between(code)
      }
      previous = code
      effects.consume(code)
      return value
    }

    function escaped(code: Code): State | undefined {
      if (code === null) return nok(code)
      if (isLineEnding(code)) return value(code)
      effects.consume(code)
      previous = code
      return value
    }

    function escapeSlash(code: Code): State | undefined {
      effects.enter('assistantMathValue')
      effects.consume(code)
      return escaped
    }

    function closeSlash(code: Code): State | undefined {
      marker()
      effects.consume(code)
      return closeBracket
    }

    function closeBracket(code: Code): State | undefined {
      effects.consume(code)
      return afterClose
    }

    function afterClose(code: Code): State | undefined {
      if (dollar) {
        if (code === 36 || isDigit(code)) return nok(code)
      }
      effects.exit('assistantMathMarker')
      effects.exit('assistantMath')
      if (flow && code !== null && !isLineEnding(code)) {
        if (!isSpace(code)) return nok(code)
        effects.enter('lineSuffix')
        return suffix(code)
      }
      return ok(code)
    }

    function suffix(code: Code): State | undefined {
      if (code === null || isLineEnding(code)) {
        effects.exit('lineSuffix')
        return ok(code)
      }
      if (!isSpace(code)) return nok(code)
      effects.consume(code)
      return suffix
    }
  }
  return { name: 'assistantMath', tokenize, concrete: flow }
}

const bracket = mathConstruct(91, 93)
const parentheses = mathConstruct(40, 41)
const singleDollar = mathConstruct(36, 36)
const syntax: Extension = {
  flow: { 92: mathConstruct(91, 93, true) },
  text: { 92: [bracket, parentheses], 36: singleDollar },
}

const fromMarkdown: FromMarkdownExtension = {
  enter: {
    assistantMath(token) {
      const display = this.sliceSerialize(token).startsWith('\\[')
      this.enter(
        {
          type: 'inlineMath',
          value: '',
          data: {
            hName: 'code',
            hProperties: {
              className: ['language-math', display ? 'math-display' : 'math-inline'],
            },
          },
        },
        token
      )
      this.buffer()
    },
  },
  exit: {
    assistantMathValue(token) {
      this.config.enter.data.call(this, token)
      this.config.exit.data.call(this, token)
    },
    assistantMath(token) {
      const value = this.resume().trim()
      const node = this.stack.at(-1) as InlineMath
      this.exit(token)
      node.value = value
      node.data!.hChildren = [{ type: 'text', value }]
    },
  },
}

/** Registers the bracket and dollar math delimiters used by chat Markdown. */
export const remarkMathDelimiters: Plugin<[], Root> = function () {
  const data = this.data()
  const syntaxExtensions = (data.micromarkExtensions ??= [])
  const treeExtensions = (data.fromMarkdownExtensions ??= [])
  syntaxExtensions.push(syntax)
  treeExtensions.push(fromMarkdown)
}

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMathDelimiters)
  .use([math.remarkPlugin])
  .freeze()

const displayMathContainers = new Set(['root', 'blockquote', 'list', 'listItem', 'paragraph'])

function dollarDisplay(source: string, start: number, end: number): string {
  const linePrefix = source.slice(source.lastIndexOf('\n', start - 1) + 1, start)
  const containerPrefix = linePrefix.match(
    /^[ \t]*(?:(?:>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+)[ \t]*)*/
  )![0]
  const continuation = containerPrefix.replace(/(?:[-+*]|\d+[.)])(?=[ \t])/g, marker =>
    ' '.repeat(marker.length)
  )
  const body = source.slice(start + 2, end - 2)
  const before = linePrefix === containerPrefix ? '' : `\n${continuation}`
  const leading = /^[ \t]*\r?\n/.test(body) ? '' : `\n${continuation}`
  const trailing = /\n[ \t>]*$/.test(body) ? '' : `\n${continuation}`
  const after = /^[ \t]*(?:\r?\n|$)/.test(source.slice(end)) ? '' : `\n${continuation}`
  return `${before}$$${leading}${body}${trailing}$$${after}`
}

/**
 * Normalizes parsed backslash TeX delimiters into dollar math while leaving
 * code, URLs, and escaped text literal.
 */
export function normalizeMathDelimiters(source: string): string {
  if (!/\\[[(]/.test(source)) return source
  const replacements: { start: number; end: number; text: string }[] = []
  const visit = (node: Nodes, allowDisplayBlock = true) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (
      node.type === 'inlineMath' &&
      start !== undefined &&
      end !== undefined &&
      source[start] === '\\'
    ) {
      replacements.push({
        start,
        end,
        text:
          source[start + 1] === '[' && allowDisplayBlock
            ? dollarDisplay(source, start, end)
            : `$$${source.slice(start + 2, end - 2)}$$`,
      })
    } else if ('children' in node) {
      const childAllowsBlock = allowDisplayBlock && displayMathContainers.has(node.type)
      node.children.forEach(child => visit(child, childAllowsBlock))
    }
  }
  visit(parser.parse(source))
  let cursor = 0
  return (
    replacements
      .map(({ start, end, text }) => {
        const before = source.slice(cursor, start)
        cursor = end
        return before + text
      })
      .join('') + source.slice(cursor)
  )
}
