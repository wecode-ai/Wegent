import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const CREATE_ZIP_SCRIPT = `
from pathlib import Path
import sys
import zipfile

archive = Path(sys.argv[1])
source = Path(sys.argv[2])
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
    for path in sorted(source.rglob("*")):
        if path.is_file():
            output.write(path, path.relative_to(source))
`

const EXTRACT_ZIP_SCRIPT = `
from pathlib import Path
import sys
import zipfile

archive = Path(sys.argv[1])
target = Path(sys.argv[2])
with zipfile.ZipFile(archive) as source:
    source.extractall(target)
`

async function runPython(script, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn('python3', ['-c', script, ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(
        new Error(
          `Python ZIP fixture command failed with ${
            signal ? `signal ${signal}` : `exit code ${code}`
          }`
        )
      )
    })
  })
}

export async function createZipFixture(archivePath, files) {
  const stagingRoot = await mkdtemp(join(dirname(archivePath), '.zip-fixture-'))
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(stagingRoot, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    await runPython(CREATE_ZIP_SCRIPT, [archivePath, stagingRoot])
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

export async function extractSingleRootZipFixture(archivePath, targetPath) {
  const extractionRoot = await mkdtemp(
    join(dirname(targetPath), `.${basename(targetPath)}-extract-`)
  )
  try {
    await runPython(EXTRACT_ZIP_SCRIPT, [archivePath, extractionRoot])
    const entries = await readdir(extractionRoot, { withFileTypes: true })
    assert.equal(entries.length, 1, 'ZIP fixture must contain exactly one root entry')
    assert.equal(entries[0].isDirectory(), true, 'ZIP fixture root entry must be a directory')
    await rm(targetPath, { recursive: true, force: true })
    await cp(join(extractionRoot, entries[0].name), targetPath, { recursive: true })
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}
