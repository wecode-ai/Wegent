#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const COMMIT_FIELD_SEPARATOR = '\u001f'
const PULL_REQUEST_SUFFIX = /\s+\(#(\d+)\)$/

export function parseReleaseCommits(output) {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const separatorIndex = line.indexOf(COMMIT_FIELD_SEPARATOR)
      if (separatorIndex === -1) {
        throw new Error(`Invalid release commit record: ${line}`)
      }

      return {
        sha: line.slice(0, separatorIndex),
        subject: line.slice(separatorIndex + COMMIT_FIELD_SEPARATOR.length),
      }
    })
}

export function formatReleaseNote({ sha, subject, authorLogin = '' }) {
  const pullRequestMatch = subject.match(PULL_REQUEST_SUFFIX)
  const pullRequestNumber = pullRequestMatch?.[1]
  const title = pullRequestNumber ? subject.replace(PULL_REQUEST_SUFFIX, '') : subject
  const attribution = authorLogin ? ` by @${authorLogin}` : ''

  if (pullRequestNumber) {
    return `- ${title}${attribution} in #${pullRequestNumber}`
  }

  return `- ${title}${attribution} (${sha.slice(0, 7)})`
}

function readReleaseCommits(previousTag, releaseSha) {
  const range = previousTag ? `${previousTag}..${releaseSha}` : releaseSha
  const output = execFileSync(
    'git',
    [
      'log',
      '--no-merges',
      `--pretty=format:%H%x1f%s`,
      range,
      '--',
      'wework/',
      'executor/',
    ],
    { encoding: 'utf8' }
  )
  return parseReleaseCommits(output)
}

export function readGitHubAuthorLogin(repo, sha, runCommand = execFileSync) {
  return runCommand(
    'gh',
    ['api', `repos/${repo}/commits/${sha}`, '--jq', '.author.login // empty'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  ).trim()
}

export function generateReleaseNotes(commits, resolveAuthorLogin) {
  return commits
    .map(commit =>
      formatReleaseNote({
        ...commit,
        authorLogin: resolveAuthorLogin(commit.sha),
      })
    )
    .join('\n')
}

function main() {
  const releaseSha = process.env.RELEASE_SHA
  const repo = process.env.GH_REPO
  if (!releaseSha) throw new Error('RELEASE_SHA is required')
  if (!repo) throw new Error('GH_REPO is required')

  const commits = readReleaseCommits(process.env.PREVIOUS_TAG || '', releaseSha)
  const notes = generateReleaseNotes(commits, sha => readGitHubAuthorLogin(repo, sha))
  if (notes) process.stdout.write(`${notes}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
