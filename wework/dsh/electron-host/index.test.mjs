import assert from 'node:assert/strict'
import test from 'node:test'
import { describe, invoke, hostDisconnectHandler } from './index.js'

test('all 4480 HTTP identity/header/capability tuples are denied before reading parameters or invoking Host', () => {
  const hosts = [
    undefined,
    '127.0.0.1:32100',
    'localhost:32100',
    '[::1]:32100',
    'rebind.attacker.test:32100',
    '127.0.0.1.evil.test:32100',
    'evil.test',
  ]
  const origins = [
    undefined,
    'null',
    'http://localhost:32100',
    'http://127.0.0.1:32100',
    'http://rebind.attacker.test:32100',
    'https://evil.test',
    'file://',
    'http://127.0.0.1:32101',
  ]
  const sites = [undefined, 'same-origin', 'same-site', 'cross-site', 'none']
  const methods = ['POST', 'GET', 'OPTIONS', 'PUT']
  const capabilities = [
    'secureStorage.get',
    'secureStorage.set',
    'secureStorage.delete',
    'filesystem.readFileChunk',
  ]
  let checked = 0
  for (const host of hosts)
    for (const origin of origins)
      for (const site of sites)
        for (const method of methods)
          for (const capability of capabilities) {
            const request = {
              headers: { host, origin, 'sec-fetch-site': site },
              method,
              capability,
              on() {
                throw new Error('Denied HTTP body must never be read')
              },
            }
            let status, payload
            const response = {
              writeHead(value) {
                status = value
              },
              end(value) {
                payload = JSON.parse(value)
              },
            }
            invoke(request, response, {
              invoke() {
                throw new Error('HTTP reached Host')
              },
            })
            assert.equal(status, 403)
            assert.equal(payload.error.code, 'capability_denied')
            checked++
          }
  assert.equal(checked, 4480)
  let status
  describe(
    {},
    {
      writeHead(value) {
        status = value
      },
      end() {},
    }
  )
  assert.equal(status, 403)
})

test('requests bounded DSH exit when the Electron host disconnects', () => {
  const exits = []
  const disconnect = hostDisconnectHandler({
    get(name) {
      assert.equal(name, 'appExit')
      return code => exits.push(code)
    },
  })

  disconnect()

  assert.deepEqual(exits, [0])
})

test('requires the launcher exit service', () => {
  assert.throws(
    () => hostDisconnectHandler({ get: () => undefined }),
    /requires the DSH launcher appExit service/
  )
})

test('HTTP cannot enumerate recovery archives or trigger credential restoration', () => {
  for (const capability of ['modelConfiguration.recovery', 'modelConfiguration.restoreRecovery']) {
    let status, result
    invoke(
      {
        method: 'POST',
        capability,
        headers: {
          host: 'rebind.attacker.test:32100',
          origin: 'http://rebind.attacker.test:32100',
          'sec-fetch-site': 'same-origin',
        },
        on() {
          throw new Error('Recovery HTTP body must not be read')
        },
      },
      {
        writeHead(value) {
          status = value
        },
        end(value) {
          result = JSON.parse(value)
        },
      },
      {
        invoke() {
          throw new Error('Recovery reached the Host through HTTP')
        },
      }
    )
    assert.equal(status, 403)
    assert.equal(result.error.code, 'capability_denied')
  }
})
