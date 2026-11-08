import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { system } from 'systeminformation'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resolveDesktopDeviceId } from './desktop-device-id.js'
import { temporaryDirectory } from './test-helpers.js'

vi.mock('systeminformation', () => ({ system: vi.fn() }))

const HARDWARE_UUID = '12345678-1234-5678-9abc-123456789abc'

describe('desktop device identity', () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>
  const options = () => ({
    applicationId: 'io.wecode.wework',
    dataDirectory: join(directory.path, 'data'),
    environment: {},
  })

  beforeEach(async () => {
    directory = await temporaryDirectory('desktop-device-id-')
    vi.mocked(system).mockReset()
    vi.mocked(system).mockResolvedValue({ uuid: HARDWARE_UUID } as Awaited<
      ReturnType<typeof system>
    >)
  })

  afterEach(async () => directory.remove())

  test('keeps identity across launches, profile deletion and different Homes', async () => {
    const first = await resolveDesktopDeviceId(options())
    expect(first).toBe('electron-9f986291bb91eddf46ea6fb186fb742adf01d60331d6c1854fa846371a3dc78d')
    expect(await resolveDesktopDeviceId(options())).toBe(first)
    expect(await readFile(join(options().dataDirectory, 'desktop-device-id'), 'utf8')).toBe(
      `${first}\n`
    )
    await rm(options().dataDirectory, { recursive: true })
    expect(await resolveDesktopDeviceId(options())).toBe(first)
    expect(
      await resolveDesktopDeviceId({
        ...options(),
        dataDirectory: join(directory.path, 'other'),
        environment: { HOME: '/another-user' },
      })
    ).toBe(first)
  })

  test('uses persisted identity without hardware lookup or rewriting old data', async () => {
    await mkdir(options().dataDirectory, { recursive: true })
    await writeFile(join(options().dataDirectory, 'desktop-device-id'), 'electron-old-random-id\n')
    await mkdir(join(options().dataDirectory, 'executor/runtime-work'), { recursive: true })
    await writeFile(
      join(options().dataDirectory, 'executor/runtime-work/worktrees.json'),
      JSON.stringify({ records: { '/repo': { deviceId: 'electron-other-machine' } } })
    )
    vi.mocked(system).mockRejectedValue(new Error('hardware unavailable'))
    expect(await resolveDesktopDeviceId(options())).toBe('electron-old-random-id')
    expect(system).not.toHaveBeenCalled()
    expect(await readFile(join(options().dataDirectory, 'desktop-device-id'), 'utf8')).toBe(
      'electron-old-random-id\n'
    )
  })

  test('separates application identifiers on the same hardware', async () => {
    expect(await resolveDesktopDeviceId(options())).not.toBe(
      await resolveDesktopDeviceId({
        ...options(),
        applicationId: 'io.wecode.other',
        dataDirectory: join(directory.path, 'other-app'),
      })
    )
  })

  test('separates machines running the same application', async () => {
    const first = await resolveDesktopDeviceId(options())
    await rm(options().dataDirectory, { recursive: true })
    vi.mocked(system).mockResolvedValue({ uuid: '87654321-4321-8765-abcd-cba987654321' } as Awaited<
      ReturnType<typeof system>
    >)
    expect(await resolveDesktopDeviceId(options())).not.toBe(first)
  })

  test('normalizes hardware UUID casing and whitespace', async () => {
    const first = await resolveDesktopDeviceId(options())
    await rm(options().dataDirectory, { recursive: true })
    vi.mocked(system).mockResolvedValue({ uuid: ` ${HARDWARE_UUID.toUpperCase()}\n` } as Awaited<
      ReturnType<typeof system>
    >)
    expect(await resolveDesktopDeviceId(options())).toBe(first)
  })

  test.each([
    '',
    '-',
    'not-a-uuid',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])('rejects unavailable hardware identity %j without random fallback', async uuid => {
    vi.mocked(system).mockResolvedValue({ uuid } as Awaited<ReturnType<typeof system>>)
    await expect(resolveDesktopDeviceId(options())).rejects.toThrow('hardware UUID')
    await expect(
      readFile(join(options().dataDirectory, 'desktop-device-id'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('propagates hardware lookup failures', async () => {
    vi.mocked(system).mockRejectedValue(new Error('hardware unavailable'))
    await expect(resolveDesktopDeviceId(options())).rejects.toThrow('hardware unavailable')
  })

  test('does not replace a corrupt persisted identity', async () => {
    await mkdir(options().dataDirectory, { recursive: true })
    await writeFile(join(options().dataDirectory, 'desktop-device-id'), '  \n')
    await expect(resolveDesktopDeviceId(options())).rejects.toThrow('identity is empty')
    expect(system).not.toHaveBeenCalled()
  })

  test('honors an identity persisted by another initializer', async () => {
    vi.mocked(system).mockImplementation(async () => {
      await mkdir(options().dataDirectory, { recursive: true })
      await writeFile(join(options().dataDirectory, 'desktop-device-id'), 'electron-winner\n')
      return { uuid: HARDWARE_UUID } as Awaited<ReturnType<typeof system>>
    })
    expect(await resolveDesktopDeviceId(options())).toBe('electron-winner')
    expect(await readFile(join(options().dataDirectory, 'desktop-device-id'), 'utf8')).toBe(
      'electron-winner\n'
    )
  })

  test('rejects an empty application identifier', async () => {
    await expect(resolveDesktopDeviceId({ ...options(), applicationId: ' ' })).rejects.toThrow(
      'application identifier is empty'
    )
  })

  test('keeps explicit verification overrides without touching hardware or saved identity', async () => {
    const first = await resolveDesktopDeviceId(options())
    vi.mocked(system).mockClear()
    expect(
      await resolveDesktopDeviceId({
        ...options(),
        environment: { WEGENT_APP_IPC_DEVICE_ID: ' configured-device ' },
      })
    ).toBe('configured-device')
    expect(system).not.toHaveBeenCalled()
    expect(await readFile(join(options().dataDirectory, 'desktop-device-id'), 'utf8')).toBe(
      `${first}\n`
    )
  })
})
