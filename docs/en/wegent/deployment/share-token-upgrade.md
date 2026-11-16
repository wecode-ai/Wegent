---
sidebar_position: 11
---

# Secure share-token upgrade

New links use random opaque tokens, SHA-256 lookup, and explicit version 2.
Existing version-1 AES URLs remain resource locators: an active login and
current resource read permission are required. Unrecorded, revoked, or expired
links are invalid. Recipients who only received a URL need resource access
granted by the resource administrator.

Version-2 unified Task links use `/shared/task/access` to preview metadata and
request access through the existing `/api/share/join` endpoint. They do not read
task content before approval. Version-1 links retain their original `/shared/task`
URLs, as do new public read-only TaskShare links, with unchanged permission rules.

## Storage compatibility

The migration preserves tokens, status, expiry, and ownership while backfilling
normalized hashes. The database version default stays at 1 and the hash remains
nullable. Multiple inserts from old binaries therefore succeed without being
misclassified as version-2 bearers. New readers locate these hashless legacy
rows only by the normalized SHA-256 of their recorded token and still enforce login and
resource permissions. Hashless version-2 or unknown-version rows cannot use
this path. New issuance always persists both hash and version 2; hash uniqueness
remains enforced.
Lookup parameters contain hashes, not raw tokens that database errors could log.

## Deployment and rollback

Storage compatibility does not secure old authorization code. Old binaries
must not continue serving share reads, attachment reads, or join endpoints.

1. Back up the database, stop share-related traffic and old writers, and drain
   in-flight requests.
2. Apply Alembic `upgrade head` or the equivalent Rust migration.
3. Start updated Python and Rust backends and verify the effective routes use
   the same authorization policy.
4. Verify recorded legacy URLs return 401 anonymously, 403 without resource
   permission, and success with existing access. Verify new read-only links are
   public but cannot bypass approval or act as invitations.
5. Restore traffic only after old binaries no longer serve these endpoints.

Downgrade removes the two new columns and hash index without rewriting URLs.
Reverting to old authorization code reintroduces the vulnerability: keep the
affected endpoints disabled or use a version with the same security backport.
A database rollback is not a secure application rollback.
