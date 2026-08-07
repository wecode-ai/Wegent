#!/usr/bin/env node
/**
 * Wiki Submit Skill - Submit wiki documentation sections to Wegent backend.
 *
 * This script simplifies the process of submitting wiki content by providing
 * a command-line interface for common operations.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')

/**
 * Parse TASK_INFO environment variable to get task data.
 * @returns {object|null} Parsed task info or null if not available
 */
function getTaskInfo() {
  const taskInfoStr = process.env.TASK_INFO
  if (!taskInfoStr) {
    return null
  }
  try {
    return JSON.parse(taskInfoStr)
  } catch (e) {
    console.error('Warning: Failed to parse TASK_INFO environment variable')
    return null
  }
}

/**
 * Get the token this skill authenticates with.
 *
 * Priority: TASK_INFO.auth_token > WEGENT_SKILL_IDENTITY_TOKEN > WIKI_TOKEN > argument
 *
 * WEGENT_SKILL_IDENTITY_TOKEN is what an executor actually sets, and is the token
 * the write API is built to accept. TASK_INFO is kept first for the runtimes that
 * provide it; AUTH_TOKEN is deliberately not used, because it is a task token with
 * no `sub` claim and the API's user lookup rejects it -- which is exactly what
 * "Invalid authorization token" was reporting.
 *
 * @param {string|undefined} argValue - Value from command line argument
 * @returns {string|undefined}
 */
function getAuthToken(argValue) {
  // First try to get from TASK_INFO (recommended)
  const taskInfo = getTaskInfo()
  if (taskInfo && taskInfo.auth_token) {
    return taskInfo.auth_token
  }

  if (process.env.WEGENT_SKILL_IDENTITY_TOKEN) {
    return process.env.WEGENT_SKILL_IDENTITY_TOKEN
  }

  // Fallback to WIKI_TOKEN environment variable
  if (process.env.WIKI_TOKEN) {
    return process.env.WIKI_TOKEN
  }

  // Finally use argument value
  return argValue
}

/**
 * Build wiki endpoint URL from TASK_API_DOMAIN or use provided value.
 * Priority: argument > WIKI_ENDPOINT env var > TASK_API_DOMAIN + default path
 * @param {string|undefined} argValue - Value from command line argument
 * @returns {string}
 */
function getWikiEndpoint(argValue) {
  // Priority 1: Use argument value if provided
  if (argValue) {
    return argValue
  }
  
  // Priority 2: Use WIKI_ENDPOINT environment variable
  if (process.env.WIKI_ENDPOINT) {
    return process.env.WIKI_ENDPOINT
  }
  
  // Priority 3: Build from TASK_API_DOMAIN
  const taskApiDomain = process.env.TASK_API_DOMAIN
  if (taskApiDomain) {
    const baseUrl = taskApiDomain.replace(/\/+$/, '') // Remove trailing slashes
    const endpoint = `${baseUrl}/api/internal/wiki/generations/contents`
    console.log(`Built wiki endpoint from TASK_API_DOMAIN: ${endpoint}`)
    return endpoint
  }
  
  console.error('Error: Wiki endpoint is required. Provide via --endpoint argument, WIKI_ENDPOINT env var, or TASK_API_DOMAIN env var.')
  process.exit(1)
}


/**
 * Make HTTP request.
 * @param {string} url - Request URL
 * @param {object} options - Request options
 * @param {string} body - Request body
 * @returns {Promise<object>}
 */
function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const protocol = parsedUrl.protocol === 'https:' ? https : http

    const req = protocol.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'POST',
        headers: options.headers,
        timeout: 60000,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode === 204) {
            resolve({ status: 'success', message: 'Content submitted successfully' })
            return
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : { status: 'success' })
            } catch {
              resolve({ status: 'success' })
            }
          } else {
            let errorMsg = `HTTP ${res.statusCode}`
            try {
              const errorDetail = JSON.parse(data)
              errorMsg = errorDetail.detail || errorMsg
            } catch {
              errorMsg = data || errorMsg
            }
            resolve({ status: 'error', message: errorMsg })
          }
        })
      }
    )

    req.on('error', (e) => {
      resolve({ status: 'error', message: e.message })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 'error', message: 'Request timeout' })
    })

    if (body) {
      req.write(body)
    }
    req.end()
  })
}

/**
 * Read one page of the generation being written.
 * @param {string} endpoint - Write endpoint URL, used to derive the read URL
 * @param {string} token - Authorization token
 * @param {number} generationId - Wiki generation ID
 * @param {string} pagePath - Stable page path
 * @returns {Promise<object>}
 */
async function readPage(endpoint, token, generationId, pagePath) {
  // The read endpoint sits beside the write one under /generations. A custom
  // endpoint that does not end in that suffix would make this a no-op and build a
  // wrong URL, whose 404 would then read as "page does not exist".
  const suffix = /\/generations\/contents\/?$/
  if (!suffix.test(endpoint)) {
    console.error(`Error: cannot derive the read URL from endpoint '${endpoint}'.`)
    console.error("It must end in '/generations/contents'.")
    process.exit(1)
  }
  const base = endpoint.replace(suffix, '')
  const url = `${base}/generations/${generationId}/pages?path=${encodeURIComponent(pagePath)}`

  return makeRequest(
    url,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    null
  )
}

/**
 * Submit wiki sections to the backend API.
 * @param {string} endpoint - API endpoint URL
 * @param {string} token - Authorization token
 * @param {number} generationId - Wiki generation ID
 * @param {Array} sections - List of section objects
 * @param {object|null} summary - Optional summary for completion
 * @returns {Promise<object>}
 */
async function submitSections(endpoint, token, generationId, sections, summary = null, removedPaths = []) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const payload = {
    generation_id: generationId,
    sections: sections,
  }

  if (summary) {
    payload.summary = summary
  }

  if (removedPaths && removedPaths.length > 0) {
    payload.removed_paths = removedPaths
  }

  return makeRequest(endpoint, { method: 'POST', headers }, JSON.stringify(payload))
}

/**
 * Handle submit command.
 * @param {object} args - Command arguments
 * @returns {Promise<number>}
 */
async function cmdSubmit(args) {
  const endpoint = getWikiEndpoint(args.endpoint)
  const token = getAuthToken(args.token)
  if (!token) {
    console.error('Error: Authorization token is required. It can be obtained from TASK_INFO, WIKI_TOKEN env var, or --token argument.')
    process.exit(1)
  }
  if (!args.generationId) {
    console.error('Error: --generation-id is required.')
    process.exit(1)
  }
  const generationId = parseInt(args.generationId, 10)

  // Get content from file or argument
  let content
  if (args.file) {
    const filePath = path.resolve(args.file)
    if (!fs.existsSync(filePath)) {
      console.error(`Error: File not found: ${args.file}`)
      return 1
    }
    content = fs.readFileSync(filePath, 'utf-8')
  } else if (args.content) {
    content = args.content
  } else {
    console.error('Error: Either --file or --content is required')
    return 1
  }

  const section = {
    // Defaults to a plain chapter: a code wiki identifies pages by path, so the
    // section type carries no meaning there and asking for one every time is noise.
    type: args.type || 'chapter',
    title: args.title,
    content: content,
  }

  if (args.path) {
    section.path = args.path
  }

  if (args.ext) {
    try {
      section.ext = JSON.parse(args.ext)
    } catch {
      console.error('Error: --ext must be valid JSON')
      return 1
    }
  }

  const result = await submitSections(endpoint, token, generationId, [section])

  if (result.status === 'error') {
    console.error(`❌ Error: ${result.message}`)
    return 1
  }

  console.log(`✅ Page '${args.path || args.title}' submitted successfully`)
  return 0
}

/**
 * Handle read command: print a page's current content.
 * @param {object} args - Command arguments
 * @returns {Promise<number>}
 */
async function cmdRead(args) {
  const endpoint = getWikiEndpoint(args.endpoint)
  const token = getAuthToken(args.token)
  if (!token) {
    console.error('Error: Authorization token is required. It can be obtained from TASK_INFO, WIKI_TOKEN env var, or --token argument.')
    process.exit(1)
  }
  if (!args.generationId) {
    console.error('Error: --generation-id is required.')
    process.exit(1)
  }
  if (!args.path) {
    console.error('Error: --path is required for read command')
    return 1
  }
  const generationId = parseInt(args.generationId, 10)

  const result = await readPage(endpoint, token, generationId, args.path)

  if (result.status === 'error') {
    // A page that does not exist yet is an answer, not a failure: in an incremental
    // run it means this page is new. Reported on stderr so it cannot be mistaken
    // for content when stdout is redirected to a file.
    // The backend's phrase, not a bare status code: any other 404 means something
    // is misconfigured, and calling that "a new page" hides it.
    if (/has no page at/i.test(result.message || '')) {
      console.error(`Page '${args.path}' does not exist yet`)
      return 0
    }
    console.error(`❌ Error: ${result.message}`)
    return 1
  }

  process.stdout.write(result.content || '')
  return 0
}

/**
 * Handle remove command: declare pages as gone.
 * @param {object} args - Command arguments
 * @returns {Promise<number>}
 */
async function cmdRemove(args) {
  const endpoint = getWikiEndpoint(args.endpoint)
  const token = getAuthToken(args.token)
  if (!token) {
    console.error('Error: Authorization token is required. It can be obtained from TASK_INFO, WIKI_TOKEN env var, or --token argument.')
    process.exit(1)
  }
  if (!args.generationId) {
    console.error('Error: --generation-id is required.')
    process.exit(1)
  }
  if (!args.paths.length) {
    console.error('Error: --path is required for remove command')
    return 1
  }
  const generationId = parseInt(args.generationId, 10)

  const result = await submitSections(endpoint, token, generationId, [], null, args.paths)

  if (result.status === 'error') {
    console.error(`❌ Error: ${result.message}`)
    return 1
  }

  console.log(`✅ Removed ${args.paths.length} page(s): ${args.paths.join(', ')}`)
  return 0
}

/**
 * Handle complete command.
 * @param {object} args - Command arguments
 * @returns {Promise<number>}
 */
async function cmdComplete(args) {
  const endpoint = getWikiEndpoint(args.endpoint)
  const token = getAuthToken(args.token)
  if (!token) {
    console.error('Error: Authorization token is required. It can be obtained from TASK_INFO, WIKI_TOKEN env var, or --token argument.')
    process.exit(1)
  }
  if (!args.generationId) {
    console.error('Error: --generation-id is required.')
    process.exit(1)
  }
  const generationId = parseInt(args.generationId, 10)

  const summary = {
    status: 'COMPLETED',
    structure_order: args.structureOrder || [],
  }

  if (args.headCommit) {
    summary.head_commit = args.headCommit
  }
  if (args.model) {
    summary.model = args.model
  }
  if (args.tokensUsed) {
    summary.tokens_used = args.tokensUsed
  }

  const result = await submitSections(endpoint, token, generationId, [], summary)

  if (result.status === 'error') {
    console.error(`❌ Error: ${result.message}`)
    return 1
  }

  // The server answers with what became of the version. It used to answer nothing,
  // so a run whose version was refused was told it had completed while its work was
  // discarded -- and this process is the only one that can still fix it.
  if (result.published === false) {
    console.error(`❌ Not published: ${result.reason || 'the publish gate refused this version'}`)
    console.error('The pages are stored but readers still see the previous wiki.')
    console.error('Write what is missing, then run complete again.')
    if (result.corrections) {
      console.error(result.corrections)
    }
    return 1
  }

  console.log('✅ Wiki generation completed and published')

  // Printed on success too, and that is the point: broken diagrams never hold a
  // version back, so this is the last moment anything can be done about them. Exit 0
  // -- the run did succeed, and failing it would undo a wiki that is live and good
  // over a figure that does not draw.
  if (result.corrections) {
    console.log('')
    console.log(result.corrections)
    console.log('Rewrite those pages and run complete again to republish.')
  }
  return 0
}

/**
 * Handle fail command.
 * @param {object} args - Command arguments
 * @returns {Promise<number>}
 */
async function cmdFail(args) {
  const endpoint = getWikiEndpoint(args.endpoint)
  const token = getAuthToken(args.token)
  if (!token) {
    console.error('Error: Authorization token is required. It can be obtained from TASK_INFO, WIKI_TOKEN env var, or --token argument.')
    process.exit(1)
  }
  if (!args.generationId) {
    console.error('Error: --generation-id is required.')
    process.exit(1)
  }
  const generationId = parseInt(args.generationId, 10)

  const summary = {
    status: 'FAILED',
    error_message: args.errorMessage,
  }

  const result = await submitSections(endpoint, token, generationId, [], summary)

  if (result.status === 'error') {
    console.error(`❌ Error: ${result.message}`)
    return 1
  }

  console.log('✅ Wiki generation marked as FAILED')
  return 0
}

/**
 * Parse command line arguments.
 * @param {string[]} argv - Command line arguments
 * @returns {object}
 */
function parseArgs(argv) {
  const args = {
    command: null,
    endpoint: null,
    token: null,
    generationId: null,
    type: null,
    title: null,
    path: null,
    paths: [],
    file: null,
    content: null,
    ext: null,
    structureOrder: [],
    model: null,
    tokensUsed: null,
    errorMessage: null,
    headCommit: null,
  }

  let i = 2 // Skip 'node' and script name
  if (argv.length > i && !argv[i].startsWith('-')) {
    args.command = argv[i]
    i++
  }

  while (i < argv.length) {
    const arg = argv[i]
    switch (arg) {
      case '--endpoint':
      case '-e':
        args.endpoint = argv[++i]
        break
      case '--token':
      case '-t':
        args.token = argv[++i]
        break
      case '--generation-id':
      case '-g':
        args.generationId = argv[++i]
        break
      case '--type':
        args.type = argv[++i]
        break
      case '--title':
        args.title = argv[++i]
        break
      case '--path':
        args.path = argv[++i]
        args.paths.push(args.path)
        break
      case '--head-commit':
        args.headCommit = argv[++i]
        break
      case '--file':
      case '-f':
        args.file = argv[++i]
        break
      case '--content':
      case '-c':
        args.content = argv[++i]
        break
      case '--ext':
        args.ext = argv[++i]
        break
      case '--structure-order':
        // Collect all following non-flag arguments
        i++
        while (i < argv.length && !argv[i].startsWith('-')) {
          args.structureOrder.push(argv[i])
          i++
        }
        i-- // Back up one since the loop will increment
        break
      case '--model':
        args.model = argv[++i]
        break
      case '--tokens-used':
        args.tokensUsed = parseInt(argv[++i], 10)
        break
      case '--error-message':
      case '-m':
        args.errorMessage = argv[++i]
        break
      case '--help':
      case '-h':
        args.command = 'help'
        break
      default:
        console.error(`Unknown argument: ${arg}`)
        process.exit(1)
    }
    i++
  }

  return args
}

/**
 * Print help message.
 */
function printHelp() {
  console.log(`
Wiki Submit Skill - Submit wiki documentation to Wegent backend

Usage: node wiki_submit.js <command> [options]

Commands:
  submit    Submit a wiki page
  read      Print a page's current content
  remove    Declare wiki pages as gone
  complete  Mark wiki generation as completed
  fail      Mark wiki generation as failed

Common Options:
  --endpoint, -e       API endpoint URL (or set WIKI_ENDPOINT env var)
  --token, -t          Authorization token (auto-detected from TASK_INFO.auth_token,
                       or set WIKI_TOKEN env var)
  --generation-id, -g  Wiki generation ID (required)

Note: The authorization token is automatically obtained from the TASK_INFO
environment variable when running inside an executor container. You don't need
to specify it manually in most cases.

Submit Options:
  --path               Stable page path, e.g. "architecture/backend". This is the
                       page's identity: keep it the same across runs.
  --title              Page title (required)
  --type               Section type, defaults to "chapter"
  --file, -f           Path to markdown file containing page content
  --content, -c        Page content (alternative to --file)
  --ext                Extension data as JSON string

Read Options:
  --path               Page path to read. Exits 0 with no output when the page
                       does not exist yet.

Remove Options:
  --path               Page path to remove. Repeat for several pages.

Complete Options:
  --head-commit        Commit that was documented, from \`git rev-parse HEAD\`
  --structure-order    Ordered list of section identifiers
  --model              Model name used for generation
  --tokens-used        Number of tokens used

Fail Options:
  --error-message, -m  Error message describing the failure

Examples:
  node wiki_submit.js submit --generation-id 123 --path architecture/backend --title "Backend Architecture" --file ./page.md
  node wiki_submit.js read --generation-id 123 --path architecture/backend > current.md
  node wiki_submit.js remove --generation-id 123 --path modules/legacy-sync
  node wiki_submit.js complete --generation-id 123 --head-commit $(git rev-parse HEAD)
  node wiki_submit.js fail --generation-id 123 --error-message "Failed to analyze repository"
`)
}

/**
 * Main entry point.
 */
async function main() {
  const args = parseArgs(process.argv)

  if (!args.command || args.command === 'help') {
    printHelp()
    process.exit(args.command === 'help' ? 0 : 1)
  }

  let exitCode
  switch (args.command) {
    case 'submit':
      if (!args.path) {
        // The path is the page's identity. Without one the write is accepted and the
        // page is then skipped at publish time, so it would report success and
        // silently produce nothing.
        console.error('Error: --path is required for submit command')
        process.exit(1)
      }
      if (!args.title) {
        console.error('Error: --title is required for submit command')
        process.exit(1)
      }
      exitCode = await cmdSubmit(args)
      break
    case 'read':
      exitCode = await cmdRead(args)
      break
    case 'remove':
      exitCode = await cmdRemove(args)
      break
    case 'complete':
      exitCode = await cmdComplete(args)
      break
    case 'fail':
      if (!args.errorMessage) {
        console.error('Error: --error-message is required for fail command')
        process.exit(1)
      }
      exitCode = await cmdFail(args)
      break
    default:
      console.error(`Unknown command: ${args.command}`)
      printHelp()
      exitCode = 1
  }

  process.exit(exitCode)
}

main()