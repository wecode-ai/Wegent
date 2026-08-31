import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64urlnopad } from '@scure/base'
import { describe, expect, it } from 'vitest'

import { createDeviceProof, publicKeyFromPrivate } from './deviceProof'

describe('device credentials', () => {
  it('creates the same ES256 device proof required by Wework refresh', () => {
    const privateKey = p256.utils.randomSecretKey(new Uint8Array(48).fill(7))
    const publicKey = publicKeyFromPrivate(privateKey)
    const proof = createDeviceProof(
      privateKey,
      publicKey,
      'refresh-token',
      '/api/auth/wework/refresh',
      1_700_000_000_000,
      'proof-id'
    )
    const [headerPart, payloadPart, signaturePart] = proof.split('.')
    const header = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(headerPart)))
    const payload = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(payloadPart)))

    expect(header).toEqual({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicKey })
    expect(payload).toMatchObject({
      htm: 'POST',
      htu: '/api/auth/wework/refresh',
      iat: 1_700_000_000,
      jti: 'proof-id',
      ath: base64urlnopad.encode(sha256(new TextEncoder().encode('refresh-token'))),
    })
    expect(
      p256.verify(
        base64urlnopad.decode(signaturePart),
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
        p256.getPublicKey(privateKey),
        { format: 'compact', prehash: true }
      )
    ).toBe(true)
  })
})
