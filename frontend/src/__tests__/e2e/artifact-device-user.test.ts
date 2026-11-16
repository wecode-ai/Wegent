/** @jest-environment node */

import { execFileSync } from 'node:child_process'
import { chown } from 'node:fs/promises'
import { prepareArtifactDeviceUser } from '../../../e2e/utils/artifact-device-user'

jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }))
jest.mock('node:fs/promises', () => ({ chown: jest.fn() }))

describe('native artifact device identity', () => {
  const rootIdentity = { platform: 'linux' as const, uid: 0 }
  const prepare = () => prepareArtifactDeviceUser('/tmp/owned-artifact', rootIdentity)

  beforeEach(() => {
    jest.mocked(chown).mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('drops root to the image account and owns only its fresh directories', async () => {
    jest.mocked(execFileSync).mockReturnValueOnce('1001\n').mockReturnValueOnce('1002\n')

    await expect(prepare()).resolves.toEqual({
      uid: 1001,
      gid: 1002,
    })
    expect(execFileSync).toHaveBeenNthCalledWith(1, 'id', ['-u', 'pwuser'], {
      encoding: 'utf8',
    })
    expect(execFileSync).toHaveBeenNthCalledWith(2, 'id', ['-g', 'pwuser'], {
      encoding: 'utf8',
    })
    expect(jest.mocked(chown).mock.calls).toEqual([
      ['/tmp/owned-artifact', 1001, 1002],
      ['/tmp/owned-artifact/home', 1001, 1002],
    ])
  })

  it.each(['darwin', 'win32'] as const)('does not change %s identities', async platform => {
    await expect(
      prepareArtifactDeviceUser('/tmp/owned-artifact', { platform, uid: 0 })
    ).resolves.toEqual({})
    expect(execFileSync).not.toHaveBeenCalled()
    expect(chown).not.toHaveBeenCalled()
  })

  it('preserves an already unprivileged Linux identity', async () => {
    await expect(
      prepareArtifactDeviceUser('/tmp/owned-artifact', { platform: 'linux', uid: 1000 })
    ).resolves.toEqual({})
    expect(execFileSync).not.toHaveBeenCalled()
    expect(chown).not.toHaveBeenCalled()
  })

  it.each(['0', '-1', 'not-an-id', '9007199254740992'])('rejects unsafe IDs: %s', async id => {
    jest.mocked(execFileSync).mockReturnValue(id)
    await expect(prepare()).rejects.toThrow('requires an unprivileged pwuser')
    expect(chown).not.toHaveBeenCalled()
  })

  it('fails explicitly when the image account is absent', async () => {
    jest.mocked(execFileSync).mockImplementation(() => {
      throw new Error('id: pwuser: no such user')
    })
    await expect(prepare()).rejects.toThrow('no such user')
    expect(chown).not.toHaveBeenCalled()
  })

  it('rejects root group membership even with a non-root user', async () => {
    jest.mocked(execFileSync).mockReturnValueOnce('1000').mockReturnValueOnce('0')
    await expect(prepare()).rejects.toThrow('requires an unprivileged pwuser -g')
    expect(chown).not.toHaveBeenCalled()
  })

  it('does not launch with inaccessible directories', async () => {
    jest.mocked(execFileSync).mockReturnValue('1000')
    jest.mocked(chown).mockRejectedValueOnce(new Error('chown failed'))
    await expect(prepare()).rejects.toThrow('chown failed')
  })
})
