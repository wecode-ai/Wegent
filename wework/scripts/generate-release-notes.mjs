#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const COMMIT_FIELD_SEPARATOR = '\u001f'
const PULL_REQUEST_SUFFIX = /\s+\(#(\d+)\)$/
const VERSION_BUMP_SUBJECT = /^chore\(wework\): bump app version to (.+)$/
const EMPTY_RELEASE_NOTES =
  '- No Wework app bundle changes detected under `wework/` or `executor/` since the previous Wework release.'

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

export function readReleaseCommits(previousRef, releaseSha, runCommand = execFileSync) {
  const range = previousRef ? `${previousRef}..${releaseSha}` : releaseSha
  const output = runCommand(
    'git',
    ['log', '--no-merges', `--pretty=format:%H%x1f%s`, range, '--', 'wework/', 'executor/'],
    { encoding: 'utf8' }
  )
  return parseReleaseCommits(output)
}

export function findPreviousReleaseRef(releaseVersion, releaseSha, runCommand = execFileSync) {
  if (!releaseVersion) return ''

  const output = runCommand(
    'git',
    [
      'log',
      '--pretty=format:%H%x1f%s',
      releaseSha,
      '--',
      'wework/package.json',
      'wework/src-tauri/tauri.conf.json',
    ],
    { encoding: 'utf8' }
  )
  const releaseCommits = parseReleaseCommits(output)
    .map(commit => ({
      ...commit,
      version: commit.subject.match(VERSION_BUMP_SUBJECT)?.[1] ?? '',
    }))
    .filter(commit => commit.version)
  const currentReleaseIndex = releaseCommits.findIndex(commit => commit.version === releaseVersion)
  const stableRelease = !releaseVersion.includes('-beta.')
  const previousRelease = releaseCommits
    .slice(currentReleaseIndex === -1 ? 0 : currentReleaseIndex + 1)
    .find(
      commit =>
        commit.version !== releaseVersion && (!stableRelease || !commit.version.includes('-beta.'))
    )

  return previousRelease?.sha ?? ''
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

export function formatReleaseNotesDocument(notes) {
  return `## Changes\n\n${notes || EMPTY_RELEASE_NOTES}`
}

function main() {
  const releaseSha =
    process.env.RELEASE_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const repo = process.env.GH_REPO
  const previousRef =
    process.env.PREVIOUS_TAG ||
    findPreviousReleaseRef(process.env.RELEASE_VERSION || '', releaseSha)

  const commits = readReleaseCommits(previousRef, releaseSha)
  const notes = generateReleaseNotes(commits, sha => (repo ? readGitHubAuthorLogin(repo, sha) : ''))
  const output =
    process.env.RELEASE_NOTES_FORMAT === 'markdown' ? formatReleaseNotesDocument(notes) : notes
  if (output) process.stdout.write(`${output}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
