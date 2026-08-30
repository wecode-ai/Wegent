#!/usr/bin/env node

import { writeFileSync } from 'node:fs'

const command = process.argv[2] ?? 'status'

if (command === 'status' || command === 'request-permissions') {
  if (process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_HANG === command) {
    setInterval(() => {}, 1_000)
  } else {
    emit({
      supported: true,
      accessibilityGranted: true,
      inputMonitoringGranted: true,
    })
  }
} else if (command === 'execute') {
  markStarted(command)
  if (process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_FAIL === command) {
    emit({ error: 'Fixture replay failed' })
    process.exitCode = 1
  } else if (process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_HANG === command) {
    setInterval(() => {}, 1_000)
  } else {
    process.stdin.resume()
    process.stdin.on('end', () => emit({ ok: true }))
  }
} else if (command === 'record') {
  let timer
  const stop = () => {
    if (timer) clearInterval(timer)
    const exitFile = process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_EXIT_FILE
    if (exitFile) writeFileSync(exitFile, 'stopped\n')
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  emit({ ready: true })
  if (process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_STDERR === 'after-ready') {
    setTimeout(() => process.stderr.write('non-fatal recorder diagnostic\n'), 25)
  }
  const samples = [
    {
      type: 'mouse',
      appName: 'Finder',
      appBundleId: 'com.apple.finder',
      windowTitle: 'Projects',
      targetRole: 'AXButton',
      targetSubrole: '',
      targetTitle: 'Documents',
      x: 312,
      y: 246,
      button: 'left',
      clickCount: 1,
    },
    {
      type: 'key',
      appName: 'TextEdit',
      appBundleId: 'com.apple.TextEdit',
      windowTitle: 'Untitled',
      targetRole: 'AXTextArea',
      targetSubrole: '',
      targetTitle: 'Document',
      keyCode: 4,
      modifiers: 0,
    },
    {
      type: 'scroll',
      appName: 'System Settings',
      appBundleId: 'com.apple.systempreferences',
      windowTitle: 'General',
      targetRole: 'AXScrollArea',
      targetSubrole: '',
      targetTitle: 'Settings content',
      x: 910,
      y: 540,
      deltaX: 0,
      deltaY: -72,
    },
  ]
  let index = 0
  timer = setInterval(() => {
    const sample = samples[index % samples.length]
    emit({
      ...sample,
      offsetMs: (index + 1) * 350,
      risk: 'low',
      replayable: true,
    })
    index += 1
  }, 350)
} else {
  emit({ error: 'Unknown fixture command' })
  process.exitCode = 1
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function markStarted(startedCommand) {
  const startedFile = process.env.WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_STARTED_FILE
  if (startedFile) writeFileSync(startedFile, `${startedCommand}\n`)
}
