import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

const workflow = JSON.parse(
  execFileSync(
    'ruby',
    [
      '-ryaml',
      '-rjson',
      '-e',
      'puts JSON.generate(YAML.load_file(ARGV[0]))',
      new URL('../workflows/wework-app.yml', import.meta.url).pathname,
    ],
    { encoding: 'utf8' }
  )
)
const { jobs } = workflow

test('release creation waits for every candidate build and validation', () => {
  for (const name of ['prepare-release', 'build']) {
    for (const step of jobs[name].steps)
      assert.doesNotMatch(step.run ?? '', /gh (release (create|edit)|api.*git\/refs)/)
  }
  assert.deepEqual(jobs.publish.needs, ['prepare-release', 'build'])
  assert.doesNotMatch(jobs.publish.if, /always\(\)/)
  const names = jobs.publish.steps.map(step => step.name)
  const create = names.indexOf('Create or update draft release')
  for (const name of [
    'Download release builds',
    'Reuse verified arm64 upgrade paths for macOS x64',
    'Generate desktop update manifests',
  ])
    assert.ok(names.indexOf(name) >= 0 && names.indexOf(name) < create, name)
  assert.ok(create < names.indexOf('Upload formal release assets'))
  const manifests = jobs.publish.steps.find(
    step => step.name === 'Generate desktop update manifests'
  )
  assert.doesNotMatch(manifests.run, /gh release view/)
  assert.match(manifests.run, /generate-release-notes.mjs/)
  assert.equal(manifests.env.GH_REPO, '${{ github.repository }}')
  for (const name of ['RELEASE_SHA', 'PREVIOUS_TAG']) assert.ok(manifests.env[name], name)
  const checkout = jobs.publish.steps.find(step => step.name === 'Checkout release source')
  assert.equal(checkout.with['fetch-depth'], 0)
})

test('all installers build while release upgrade E2E runs only on arm64 macOS and Windows', () => {
  assert.deepEqual(
    jobs.build.strategy.matrix.include.map(item => [item.platform, item.arch]),
    [
      ['macos', 'arm64'],
      ['macos', 'x64'],
      ['windows', 'x64'],
      ['linux', 'x64'],
    ]
  )
  for (const name of [
    'Verify declared upgrade and rollback edges on real release packages',
    'Upload verified release upgrade evidence',
  ]) {
    const step = jobs.build.steps.find(step => step.name === name)
    assert.equal(
      step.if,
      "(matrix.platform == 'macos' && matrix.arch == 'arm64') || matrix.platform == 'windows'"
    )
  }
  const reuse = jobs.publish.steps.find(
    step => step.name === 'Reuse verified arm64 upgrade paths for macOS x64'
  )
  assert.match(reuse.run, /mirror-macos-upgrade-policy.mjs/)
})
