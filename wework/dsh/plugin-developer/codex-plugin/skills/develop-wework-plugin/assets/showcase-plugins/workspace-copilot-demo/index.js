import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'

export const name = 'workspace-copilot-demo'
export const inject = ['weworkPluginRuntime']

const IGNORED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.next',
  '.pytest_cache',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
])
const LANGUAGE_BY_EXTENSION = new Map([
  ['.c', 'C'],
  ['.cpp', 'C++'],
  ['.cs', 'C#'],
  ['.go', 'Go'],
  ['.java', 'Java'],
  ['.js', 'JavaScript'],
  ['.jsx', 'JavaScript'],
  ['.kt', 'Kotlin'],
  ['.php', 'PHP'],
  ['.py', 'Python'],
  ['.rb', 'Ruby'],
  ['.rs', 'Rust'],
  ['.swift', 'Swift'],
  ['.ts', 'TypeScript'],
  ['.tsx', 'TypeScript'],
  ['.vue', 'Vue'],
])

export function apply(ctx) {
  ctx.weworkPluginRuntime.register(ctx, {
    id: 'workspace-copilot',
    methods: { analyze: analyzeWorkspace },
  })
}

export async function analyzeWorkspace({ cwd }) {
  const root = await requiredWorkspace(cwd)
  const files = await collectFiles(root)
  const languages = new Map()
  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION.get(extname(file).toLowerCase())
    if (language) languages.set(language, (languages.get(language) ?? 0) + 1)
  }
  const packageManifests = await Promise.all(
    files
      .filter(file => basename(file) === 'package.json')
      .slice(0, 60)
      .map(file => readJson(file))
  )
  const pythonManifests = await Promise.all(
    files
      .filter(file => basename(file) === 'pyproject.toml')
      .slice(0, 30)
      .map(file => readText(file))
  )
  const dependencies = new Set(
    packageManifests.flatMap(manifest => [
      ...Object.keys(manifest?.dependencies ?? {}),
      ...Object.keys(manifest?.devDependencies ?? {}),
    ])
  )
  const pythonManifest = pythonManifests.join('\n').toLowerCase()
  const frameworks = [
    ['Next.js', dependencies.has('next')],
    ['React', dependencies.has('react')],
    ['Electron', dependencies.has('electron')],
    ['Vue', dependencies.has('vue')],
    ['Vite', dependencies.has('vite')],
    ['Vitest', dependencies.has('vitest')],
    ['FastAPI', pythonManifest.includes('fastapi')],
    ['Django', pythonManifest.includes('django')],
    ['Pytest', pythonManifest.includes('pytest')],
  ]
    .filter(([, detected]) => detected)
    .map(([label]) => label)
  const importantNames = new Set([
    'AGENTS.md',
    'README.md',
    'package.json',
    'pnpm-workspace.yaml',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'Dockerfile',
  ])

  return {
    root: basename(root),
    path: root,
    fileCount: files.length,
    languages: [...languages.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 6),
    frameworks,
    scripts: [
      ...new Set(packageManifests.flatMap(manifest => Object.keys(manifest?.scripts ?? {}))),
    ].slice(0, 8),
    importantFiles: files
      .map(file => relative(root, file))
      .filter(file => importantNames.has(basename(file)))
      .slice(0, 10),
  }
}

async function requiredWorkspace(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('Workspace path must be absolute')
  }
  const info = await stat(value)
  if (!info.isDirectory()) throw new Error('Workspace path must be a directory')
  return value
}

async function collectFiles(root) {
  const files = []
  const directories = [{ path: root, depth: 0 }]
  while (directories.length > 0 && files.length < 1500) {
    const directory = directories.shift()
    if (!directory || directory.depth > 6) continue
    let entries
    try {
      entries = await readdir(directory.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= 1500) break
      const path = join(directory.path, entry.name)
      if (entry.isDirectory()) {
        if (
          !IGNORED_DIRECTORIES.has(entry.name) &&
          (!entry.name.startsWith('.') || entry.name === '.github')
        ) {
          directories.push({ path, depth: directory.depth + 1 })
        }
      } else if (entry.isFile()) {
        files.push(path)
      }
    }
  }
  return files
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}
