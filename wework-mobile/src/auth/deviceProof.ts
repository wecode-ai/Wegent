import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64urlnopad } from '@scure/base'

export interface DevicePublicKey {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

export function createDeviceProof(
  privateKey: Uint8Array,
  publicKey: DevicePublicKey,
  refreshToken: string,
  endpointPath: string,
  now: number,
  id: string
): string {
  const header = encodeJson({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicKey })
  const payload = encodeJson({
    htm: 'POST',
    htu: endpointPath,
    iat: Math.floor(now / 1000),
    jti: id,
    ath: encodeBase64Url(sha256(utf8(refreshToken))),
  })
  const signingInput = `${header}.${payload}`
  const signature = p256.sign(utf8(signingInput), privateKey, {
    format: 'compact',
    prehash: true,
  })
  return `${signingInput}.${encodeBase64Url(signature)}`
}

export function publicKeyFromPrivate(privateKey: Uint8Array): DevicePublicKey {
  const publicKey = p256.getPublicKey(privateKey, false)
  if (publicKey.length !== 65 || publicKey[0] !== 4) {
    throw new Error('生成的设备公钥无效')
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: encodeBase64Url(publicKey.slice(1, 33)),
    y: encodeBase64Url(publicKey.slice(33, 65)),
  }
}

export function encodeBase64Url(value: Uint8Array): string {
  return base64urlnopad.encode(value)
}

export function decodeBase64Url(value: string): Uint8Array {
  return base64urlnopad.decode(value)
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(utf8(JSON.stringify(value)))
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
