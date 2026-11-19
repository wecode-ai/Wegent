import assert from 'node:assert/strict'

export let desktopOwnerId
export let desktopOwnerPrimaryTaskId
export let desktopOwnerCoordinatorTaskId
let owner

/** Bind every checkpoint fixture to the account authenticated by the real Backend. */
export function bindDesktopOwner(profile) {
  assert.ok(Number.isSafeInteger(profile?.id) && profile.id > 0, 'Invalid Backend owner ID')
  owner = { id: profile.id, user_name: profile.user_name }
  desktopOwnerId = owner.id
  desktopOwnerPrimaryTaskId = `stand-in-chat-${owner.id}-primary`
  desktopOwnerCoordinatorTaskId = `stand-in-coordinator-${owner.id}`
}

export function getDesktopOwner() {
  assert.ok(owner, 'The real Backend owner must be bound before preparing checkpoint fixtures')
  return owner
}
