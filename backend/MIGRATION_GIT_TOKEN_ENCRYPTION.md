# Git Token Encryption Migration

## Overview

This migration adds encryption for GitLab and GitHub tokens stored in the database. Previously, tokens were stored in plain text in the `git_info` JSON field. Now they are encrypted using AES-256-CBC encryption.

## Changes Made

### 1. New Encryption Module (`app/core/crypto.py`)
- `encrypt_git_token()`: Encrypts a plain text token using AES-256-CBC
- `decrypt_git_token()`: Decrypts an encrypted token back to plain text
- `is_token_encrypted()`: Checks if a token is already encrypted

### 2. User Service Updates (`app/services/user.py`)
- Modified `_validate_git_info()` to encrypt tokens before saving to database
- Tokens are encrypted after validation but before storage

### 3. Provider Updates
- **GitHub Provider** (`app/repository/github_provider.py`):
  - Added `_decrypt_token()` helper method
  - All token usage now decrypts tokens before API calls

- **GitLab Provider** (`app/repository/gitlab_provider.py`):
  - Added `_decrypt_token()` helper method
  - All token usage now decrypts tokens before API calls

### 4. Migration Script (`migrate_encrypt_tokens.py`)
- Encrypts all existing plain text tokens in the database
- Safe to run multiple times (skips already encrypted tokens)

## Encryption Details

- **Algorithm**: AES-256-CBC
- **Key**: Uses `SHARE_TOKEN_AES_KEY` from settings (32 bytes)
- **IV**: Uses `SHARE_TOKEN_AES_IV` from settings (16 bytes)
- **Encoding**: Base64 encoding of encrypted bytes

## Running the Migration

### Prerequisites

1. **Configure encryption keys** in your `.env` file:
   ```bash
   # For production, generate secure random keys:
   SHARE_TOKEN_AES_KEY=$(openssl rand -hex 16)  # 32 characters for AES-256
   SHARE_TOKEN_AES_IV=$(openssl rand -hex 8)    # 16 characters for AES IV
   ```

   Add these to your `.env` file:
   ```bash
   SHARE_TOKEN_AES_KEY=<your-32-character-key>
   SHARE_TOKEN_AES_IV=<your-16-character-iv>
   ```

   **WARNING**: Never use the default keys from `.env.example` in production!

2. Ensure `pymysql` is installed for synchronous database access:
   ```bash
   pip install pymysql
   ```

3. Ensure `cryptography` package is installed:
   ```bash
   pip install cryptography
   ```

### Steps

1. **Backup your database** before running the migration:
   ```bash
   mysqldump -u user -p task_manager > backup_before_encryption.sql
   ```

2. **Run the migration script**:
   ```bash
   cd backend
   python migrate_encrypt_tokens.py
   ```

3. **Verify the migration**:
   - Check the logs for any errors
   - Verify that users can still access their repositories
   - Test creating new users with git tokens

### Migration Output

The script will output:
- Number of users found
- Which users' tokens were encrypted
- Total number of users updated
- Any errors encountered

Example output:
```
INFO:__main__:Starting git token encryption migration...
INFO:__main__:Database URL: mysql+pymysql://...
INFO:__main__:Found 5 active users
INFO:__main__:Encrypted token for user admin, type: github
INFO:__main__:Encrypted token for user admin, type: gitlab
INFO:__main__:Successfully updated 1 users
INFO:__main__:Migration completed. Updated 1 users.
```

## Backward Compatibility

The decryption function includes fallback logic:
- If decryption fails, it returns the original token
- This handles edge cases where tokens might still be in plain text
- However, all new tokens will be encrypted

## Security Considerations

1. **Key Management**:
   - The AES key and IV are stored in environment variables
   - Ensure `.env` file is not committed to version control
   - Consider using a proper secrets management system in production

2. **Key Rotation**:
   - If you need to rotate encryption keys, you'll need to:
     1. Decrypt all tokens with the old key
     2. Update the key in settings
     3. Re-encrypt all tokens with the new key

3. **Database Backups**:
   - Encrypted tokens in database backups are only as secure as the encryption key
   - Protect your encryption keys separately from database backups

## Testing

After migration, verify:
1. Existing users can still fetch repositories
2. Token validation still works
3. New users can add git tokens
4. Repository operations work correctly

## Rollback

If you need to rollback:
1. Restore from database backup
2. Revert code changes
3. Restart the application

## Future Improvements

Potential enhancements:
- Add key rotation support
- Use hardware security modules (HSM) for key storage
- Implement per-user encryption keys
- Add audit logging for token access
