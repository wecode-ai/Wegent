const { pathToFileURL } = require('url')

/**
 * Extract Mermaid fenced code blocks while ignoring fences quoted in another block.
 * @param {string} markdown - Markdown content
 * @returns {{ blocks: Array<{body: string, line: number}>, errors: string[] }}
 */
function extractMermaidBlocks(markdown) {
  const blocks = []
  const errors = []
  const lines = markdown.split(/\r?\n/)
  let openFence = null

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (openFence) {
      const isClosingFence = new RegExp(
        `^\\s*${openFence.marker[0]}{${openFence.marker.length},}\\s*$`
      ).test(line)
      if (isClosingFence) {
        if (openFence.language === 'mermaid') {
          blocks.push({ body: openFence.body.join('\n'), line: openFence.line })
        }
        openFence = null
      } else if (openFence.language === 'mermaid') {
        openFence.body.push(line)
      }
      continue
    }

    const openingFence = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (!openingFence) {
      continue
    }

    const language = openingFence[2].trim().split(/\s+/, 1)[0].toLowerCase()
    openFence = {
      marker: openingFence[1],
      language,
      line: index + 1,
      body: [],
    }
  }

  if (openFence && openFence.language === 'mermaid') {
    errors.push(`Mermaid block starting at line ${openFence.line} has no closing fence.`)
  }

  return { blocks, errors }
}

/**
 * Load Mermaid after installing the DOM globals it requires in Node.js.
 * @returns {Promise<{mermaid: object}|{error: string}>}
 */
async function loadMermaidParser() {
  try {
    const { JSDOM } = require('jsdom')
    if (typeof global.window === 'undefined') {
      const dom = new JSDOM('<!DOCTYPE html><body></body>')
      global.window = dom.window
      global.document = dom.window.document
    }

    // Require resolves global packages through NODE_PATH; dynamic import then keeps
    // Mermaid's ESM entry point working in this CommonJS skill.
    const mermaidPath = require.resolve('mermaid')
    const module = await import(pathToFileURL(mermaidPath).href)
    return { mermaid: module.default }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Turn a Mermaid parser exception into a concise correction hint.
 * @param {unknown} error - Mermaid parser exception
 * @returns {string}
 */
function formatMermaidError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Unknown Mermaid parser error'
}

function flowchartDeclarationText(line) {
  let result = ''
  let quote = null

  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (quote) {
      if (character === '\\') {
        index += 1
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (line.startsWith('%%', index)) {
      break
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    result += character
  }

  return result
}

/**
 * Detect the flowchart ID collision Mermaid's parser accepts but its layout rejects.
 * @param {string} body - Mermaid block content
 * @returns {string|null}
 */
function findFlowchartSubgraphCollision(body) {
  const lines = body.split(/\r?\n/)
  const declaration = lines.find((line) => {
    const trimmed = line.trim()
    return trimmed && !trimmed.startsWith('%%')
  })
  if (!declaration || !/^(flowchart|graph)(?:\s|:|$)/i.test(declaration.trim())) {
    return null
  }

  const subgraphs = new Set()
  for (const line of lines) {
    const match = line.match(/^\s*subgraph\s+([A-Za-z_][A-Za-z0-9_-]*)\b/i)
    if (match) {
      subgraphs.add(match[1])
    }
  }
  if (subgraphs.size === 0) {
    return null
  }

  for (const line of lines) {
    if (/^\s*subgraph\s+/i.test(line)) {
      continue
    }
    const declaration = flowchartDeclarationText(line)
    const nodeIds = new Set()
    for (const match of declaration.matchAll(/\b([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})/g)) {
      nodeIds.add(match[1])
    }
    const standalone = declaration.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*$/)
    if (standalone) {
      nodeIds.add(standalone[1])
    }
    for (const nodeId of nodeIds) {
      if (subgraphs.has(nodeId)) {
        return `node id '${nodeId}' duplicates a subgraph id; Mermaid would make the node its own parent`
      }
    }
  }

  return null
}

/**
 * Validate every Mermaid block in a Markdown page with parser and layout safeguards.
 * @param {string} markdown - Markdown content
 * @returns {Promise<{status: string, blocks?: number, errors?: string[], failures?: Array<{line: number, error: string}>, loadError?: string}>}
 */
async function validateMermaidMarkdown(markdown) {
  const { blocks, errors } = extractMermaidBlocks(markdown)
  if (errors.length > 0) {
    return { status: 'invalid', errors }
  }
  if (blocks.length === 0) {
    return { status: 'passed', blocks: 0 }
  }

  const failures = []
  for (const block of blocks) {
    const structuralError = findFlowchartSubgraphCollision(block.body)
    if (structuralError) {
      failures.push({ line: block.line, error: structuralError })
    }
  }
  if (failures.length > 0) {
    return { status: 'invalid', failures }
  }

  const parser = await loadMermaidParser()
  if ('error' in parser) {
    return { status: 'unavailable', loadError: parser.error }
  }

  for (const block of blocks) {
    try {
      await parser.mermaid.parse(block.body)
    } catch (error) {
      failures.push({ line: block.line, error: formatMermaidError(error) })
    }
  }

  return failures.length > 0
    ? { status: 'invalid', failures }
    : { status: 'passed', blocks: blocks.length }
}

module.exports = { validateMermaidMarkdown }
