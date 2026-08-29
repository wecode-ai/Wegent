#!/usr/bin/env node

const command = process.argv[2] ?? 'status'

if (command === 'status' || command === 'request-permissions') {
  emit({
    supported: true,
    accessibilityGranted: true,
    inputMonitoringGranted: true,
  })
} else if (command === 'execute') {
  process.stdin.resume()
  process.stdin.on('end', () => emit({ ok: true }))
} else if (command === 'record') {
  emit({ ready: true })
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
  const timer = setInterval(() => {
    const sample = samples[index % samples.length]
    emit({
      ...sample,
      offsetMs: (index + 1) * 350,
      risk: 'low',
      replayable: true,
    })
    index += 1
  }, 350)
  const stop = () => {
    clearInterval(timer)
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
} else {
  emit({ error: 'Unknown fixture command' })
  process.exitCode = 1
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
