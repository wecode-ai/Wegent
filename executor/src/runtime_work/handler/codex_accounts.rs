// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use uuid::Uuid;

const ACCOUNT_STORE_VERSION: u8 = 1;
const ACCOUNT_STORE_DIRECTORY: &str = "wework-account-profiles";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredCodexAccount {
    id: String,
    identity: String,
    account_type: String,
    email: Option<String>,
    plan_type: Option<String>,
    created_at: i64,
    last_used_at: i64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexAccountStore {
    version: u8,
    active_account_id: Option<String>,
    accounts: Vec<StoredCodexAccount>,
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn list_codex_accounts(&self) -> Result<Value, AppIpcError> {
        let store = update_current_account()
            .map_err(|error| AppIpcError::new("codex_accounts_read_failed", error))?;
        Ok(account_store_response(&store))
    }

    pub(super) async fn switch_codex_account(&self, payload: Value) -> Result<Value, AppIpcError> {
        let account_id = string_field(&payload, "accountId")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppIpcError::new("invalid_request", "accountId is required"))?;
        let _restart_guard = codex_app_server_restart_gate().lock().await;
        self.codex_app_server
            .mutate_auth_if_idle(|| activate_account(account_id.trim()))
            .await
            .map_err(codex_auth_mutation_error)?;
        self.list_codex_accounts().await
    }

    pub(super) async fn preserve_current_codex_account(&self) -> Result<(), AppIpcError> {
        update_current_account()
            .map(|_| ())
            .map_err(|error| AppIpcError::new("codex_accounts_write_failed", error))
    }
}

fn codex_auth_mutation_error(error: CodexIdleMutationError) -> AppIpcError {
    match error {
        CodexIdleMutationError::Busy {
            active_turn_count,
            pending_request_count,
        } => AppIpcError::new(
            "codex_account_switch_busy",
            format!(
                "cannot switch Codex account while work is active \
                 ({active_turn_count} active turns, {pending_request_count} pending requests)"
            ),
        ),
        CodexIdleMutationError::Update(error) => {
            AppIpcError::new("codex_account_switch_failed", error)
        }
    }
}

pub(super) fn current_codex_account_type() -> Result<Option<String>, String> {
    let auth = match fs::read(current_auth_path()) {
        Ok(auth) => auth,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to read current Codex authentication: {error}"
            ))
        }
    };
    Ok(parse_auth_account(&auth).map(|account| account.account_type))
}

fn update_current_account() -> Result<CodexAccountStore, String> {
    let mut store = read_account_store()?;
    let auth = match fs::read(current_auth_path()) {
        Ok(auth) => auth,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if store.active_account_id.is_some() {
                store.active_account_id = None;
                write_account_store(&store)?;
            }
            return Ok(store);
        }
        Err(error) => {
            return Err(format!(
                "failed to read current Codex authentication: {error}"
            ));
        }
    };
    let account = parse_auth_account(&auth)
        .ok_or_else(|| "current Codex authentication has no account identity".to_owned())?;
    let identity = account_identity(&account, &auth);
    let now = chrono::Utc::now().timestamp_millis();
    let account_id = if let Some(existing) = store
        .accounts
        .iter_mut()
        .find(|candidate| candidate.identity == identity)
    {
        existing.account_type = account.account_type;
        existing.email = account.email;
        existing.plan_type = account.plan_type;
        existing.last_used_at = now;
        existing.id.clone()
    } else {
        let id = Uuid::new_v4().to_string();
        store.accounts.push(StoredCodexAccount {
            id: id.clone(),
            identity,
            account_type: account.account_type,
            email: account.email,
            plan_type: account.plan_type,
            created_at: now,
            last_used_at: now,
        });
        id
    };
    write_private_file(&account_auth_path(&account_id), &auth)?;
    store.active_account_id = Some(account_id);
    write_account_store(&store)?;
    Ok(store)
}

fn activate_account(account_id: &str) -> Result<(), String> {
    let mut store = read_account_store()?;
    let account = store
        .accounts
        .iter_mut()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "Codex account was not found".to_owned())?;
    let auth = fs::read(account_auth_path(account_id))
        .map_err(|error| format!("failed to read saved Codex account: {error}"))?;
    write_private_file(&current_auth_path(), &auth)?;
    account.last_used_at = chrono::Utc::now().timestamp_millis();
    store.active_account_id = Some(account_id.to_owned());
    write_account_store(&store)
}

fn account_store_response(store: &CodexAccountStore) -> Value {
    json!({
        "activeAccountId": store.active_account_id,
        "accounts": store.accounts.iter().map(|account| json!({
            "id": account.id,
            "accountType": account.account_type,
            "email": account.email,
            "planType": account.plan_type,
            "createdAt": account.created_at,
            "lastUsedAt": account.last_used_at,
        })).collect::<Vec<_>>(),
    })
}

struct ParsedAuthAccount {
    account_type: String,
    email: Option<String>,
    plan_type: Option<String>,
    token_account_id: Option<String>,
}

fn parse_auth_account(auth: &[u8]) -> Option<ParsedAuthAccount> {
    let auth = serde_json::from_slice::<Value>(auth).ok()?;
    let claims = auth
        .pointer("/tokens/id_token")
        .and_then(Value::as_str)
        .and_then(parse_jwt_claims);
    let token_account_id = normalized_string(auth.pointer("/tokens/account_id")).or_else(|| {
        claims.as_ref().and_then(|claims| {
            normalized_string(claims.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id"))
        })
    });
    let account_type = auth_account_type(&auth, token_account_id.as_deref());
    let email = claims
        .as_ref()
        .and_then(|claims| normalized_string(claims.get("email")));
    let plan_type = claims.as_ref().and_then(|claims| {
        normalized_string(claims.pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type"))
    });
    if account_type == "unknown" && token_account_id.is_none() && email.is_none() {
        return None;
    }
    Some(ParsedAuthAccount {
        account_type: account_type.to_owned(),
        email,
        plan_type,
        token_account_id,
    })
}

fn auth_account_type<'a>(auth: &'a Value, token_account_id: Option<&str>) -> &'a str {
    let has_api_key = normalized_string(auth.get("OPENAI_API_KEY")).is_some();
    match auth.get("auth_mode").and_then(Value::as_str) {
        Some("chatgpt") if has_api_key => "unknown",
        Some(mode) => mode,
        None if has_api_key => "apikey",
        None if token_account_id.is_some() => "chatgpt",
        None => "unknown",
    }
}

fn parse_jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn normalized_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn account_identity(account: &ParsedAuthAccount, auth: &[u8]) -> String {
    let token_account_id = account.token_account_id.as_deref().unwrap_or_default();
    let email = account.email.as_deref().unwrap_or_default().to_lowercase();
    if !email.is_empty() || !token_account_id.is_empty() {
        return format!("{email}\0{token_account_id}");
    }
    format!("{:x}", Sha256::digest(auth))
}

pub(super) fn quota_account_identity(request: &ExecutionRequest) -> Result<Option<String>, String> {
    let home = crate::agents::instance_home::request_home(request)
        .unwrap_or_else(crate::agents::wework_codex_home);
    let auth = match fs::read(home.join("auth.json")) {
        Ok(auth) => auth,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Codex account identity is unavailable".into()),
    };
    let account = parse_auth_account(&auth).ok_or("Codex account identity is invalid")?;
    Ok(Some(format!(
        "{:x}",
        Sha256::digest(account_identity(&account, &auth).as_bytes())
    )))
}

fn current_auth_path() -> PathBuf {
    crate::agents::wework_codex_home().join("auth.json")
}

fn account_store_directory() -> PathBuf {
    crate::agents::wework_codex_home().join(ACCOUNT_STORE_DIRECTORY)
}

fn account_store_path() -> PathBuf {
    account_store_directory().join("accounts.json")
}

fn account_auth_path(account_id: &str) -> PathBuf {
    account_store_directory().join(format!("{account_id}.auth.json"))
}

fn read_account_store() -> Result<CodexAccountStore, String> {
    match fs::read(account_store_path()) {
        Ok(content) => {
            let store: CodexAccountStore = serde_json::from_slice(&content)
                .map_err(|error| format!("failed to parse Codex account store: {error}"))?;
            if store.version != ACCOUNT_STORE_VERSION {
                return Err("unsupported Codex account store version".to_owned());
            }
            Ok(store)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CodexAccountStore {
            version: ACCOUNT_STORE_VERSION,
            ..CodexAccountStore::default()
        }),
        Err(error) => Err(format!("failed to read Codex account store: {error}")),
    }
}

fn write_account_store(store: &CodexAccountStore) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("failed to serialize Codex account store: {error}"))?;
    write_private_file(&account_store_path(), &content)
}

fn write_private_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let write_path = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::canonicalize(path)
            .map_err(|error| format!("failed to resolve Codex account link: {error}"))?,
        Ok(_) | Err(_) => path.to_owned(),
    };
    let parent = write_path
        .parent()
        .ok_or_else(|| "Codex account path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create Codex account directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to create Codex account temp file: {error}"))?;
    temporary
        .write_all(content)
        .map_err(|error| format!("failed to write Codex account temp file: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to secure Codex account temp file: {error}"))?;
    }
    temporary
        .persist(&write_path)
        .map_err(|error| format!("failed to replace Codex account file: {}", error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvRestore(Option<std::ffi::OsString>);

    impl EnvRestore {
        fn capture() -> Self {
            Self(env::var_os("WEGENT_CODEX_HOME"))
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => env::set_var("WEGENT_CODEX_HOME", value),
                None => env::remove_var("WEGENT_CODEX_HOME"),
            }
        }
    }

    #[test]
    fn classifies_legacy_credentials_without_reclassifying_api_keys_or_unknown_modes() {
        let claims = URL_SAFE_NO_PAD
            .encode(br#"{"https://api.openai.com/auth":{"chatgpt_account_id":"workspace-1"}}"#);
        for (auth, expected) in [
            (json!({"auth_mode":"chatgpt"}), "chatgpt"),
            (json!({"tokens":{"account_id":"workspace-1"}}), "chatgpt"),
            (
                json!({"tokens":{"id_token":format!("header.{claims}.signature")}}),
                "chatgpt",
            ),
            (
                json!({"OPENAI_API_KEY":"synthetic-key","tokens":{"account_id":"workspace-1"}}),
                "apikey",
            ),
            (
                json!({"auth_mode":"apiKey","tokens":{"account_id":"workspace-1"}}),
                "apiKey",
            ),
            (
                json!({"auth_mode":"future","tokens":{"account_id":"workspace-1"}}),
                "future",
            ),
            (
                json!({"auth_mode":"chatgpt","OPENAI_API_KEY":"synthetic-key","tokens":{"account_id":"workspace-1"}}),
                "unknown",
            ),
        ] {
            let parsed = parse_auth_account(&serde_json::to_vec(&auth).unwrap()).unwrap();
            assert_eq!(parsed.account_type, expected);
        }
        let claims = URL_SAFE_NO_PAD.encode(br#"{"email":"one@example.test"}"#);
        let auth = json!({"tokens":{"id_token":format!("header.{claims}.signature")}});
        assert_eq!(
            parse_auth_account(&serde_json::to_vec(&auth).unwrap())
                .unwrap()
                .account_type,
            "unknown"
        );
        assert!(parse_auth_account(br#"{"tokens":{}}"#).is_none());
    }

    #[test]
    fn reading_auth_type_does_not_create_or_update_account_snapshots() {
        let _lock = crate::test_env::lock();
        let _restore = EnvRestore::capture();
        let home = tempfile::tempdir().unwrap();
        env::set_var("WEGENT_CODEX_HOME", home.path());
        assert_eq!(current_codex_account_type().unwrap(), None);
        for (auth, expected) in [
            (
                br#"{"tokens":{"account_id":"workspace-1"}}"#.as_slice(),
                Some("chatgpt"),
            ),
            (
                br#"{"OPENAI_API_KEY":"synthetic-key"}"#.as_slice(),
                Some("apikey"),
            ),
            (b"invalid".as_slice(), None),
        ] {
            fs::write(current_auth_path(), auth).unwrap();
            assert_eq!(current_codex_account_type().unwrap().as_deref(), expected);
            assert_eq!(fs::read(current_auth_path()).unwrap(), auth);
            assert!(!account_store_directory().exists());
        }
    }

    #[test]
    fn saves_each_auth_file_and_switches_only_the_active_auth() {
        let _lock = crate::test_env::lock();
        let _restore = EnvRestore::capture();
        let home = tempfile::tempdir().expect("Codex home should be created");
        env::set_var("WEGENT_CODEX_HOME", home.path());
        let first_auth =
            br#"{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-1"},"secret":"first"}"#;
        let second_auth =
            br#"{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-2"},"secret":"second"}"#;

        write_private_file(&current_auth_path(), first_auth).expect("first auth should be written");
        let first = update_current_account().expect("first account should be saved");
        let first_id = first
            .active_account_id
            .expect("first account should be active");

        write_private_file(&current_auth_path(), second_auth)
            .expect("second auth should be written");
        let second = update_current_account().expect("second account should be saved");
        assert_eq!(second.accounts.len(), 2);
        assert_ne!(second.active_account_id.as_deref(), Some(first_id.as_str()));

        activate_account(&first_id).expect("first account should be activated");

        assert_eq!(
            fs::read(current_auth_path()).expect("active auth should be readable"),
            first_auth
        );
        let switched = read_account_store().expect("account store should remain readable");
        assert_eq!(
            switched.active_account_id.as_deref(),
            Some(first_id.as_str())
        );
        assert_eq!(switched.accounts.len(), 2);
    }

    #[test]
    fn refreshed_auth_updates_the_existing_account_snapshot() {
        let _lock = crate::test_env::lock();
        let _restore = EnvRestore::capture();
        let home = tempfile::tempdir().expect("Codex home should be created");
        env::set_var("WEGENT_CODEX_HOME", home.path());

        write_private_file(
            &current_auth_path(),
            br#"{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-1"},"secret":"old"}"#,
        )
        .expect("old auth should be written");
        update_current_account().expect("account should be saved");
        write_private_file(
            &current_auth_path(),
            br#"{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-1"},"secret":"new"}"#,
        )
        .expect("new auth should be written");
        let updated = update_current_account().expect("account should be updated");

        assert_eq!(updated.accounts.len(), 1);
        let account_id = updated
            .active_account_id
            .expect("account should remain active");
        assert_eq!(
            fs::read(account_auth_path(&account_id)).expect("snapshot should be readable"),
            br#"{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-1"},"secret":"new"}"#
        );
    }

    #[cfg(unix)]
    #[test]
    fn switching_accounts_preserves_the_shared_auth_symlink() {
        let _lock = crate::test_env::lock();
        let _restore = EnvRestore::capture();
        let home = tempfile::tempdir().expect("Codex home should be created");
        let shared_home = tempfile::tempdir().expect("shared Codex home should be created");
        let shared_auth = shared_home.path().join("auth.json");
        env::set_var("WEGENT_CODEX_HOME", home.path());
        write_private_file(
            &shared_auth,
            br#"{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-1"}}"#,
        )
        .expect("shared auth should be written");
        std::os::unix::fs::symlink(&shared_auth, current_auth_path())
            .expect("shared auth should be linked");
        let first = update_current_account().expect("first account should be saved");
        let first_id = first
            .active_account_id
            .expect("first account should be active");

        write_private_file(
            &shared_auth,
            br#"{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-2"}}"#,
        )
        .expect("second auth should be written");
        update_current_account().expect("second account should be saved");
        activate_account(&first_id).expect("first account should be restored");

        assert_eq!(
            fs::read_link(current_auth_path()).expect("auth link should remain intact"),
            shared_auth
        );
        assert_eq!(
            fs::read(shared_auth).expect("shared auth should contain the selected account"),
            br#"{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-1"}}"#
        );
    }

    #[test]
    fn reads_account_metadata_from_auth_file_without_account_rpc() {
        let claims = URL_SAFE_NO_PAD.encode(
            br#"{"email":"one@example.com","https://api.openai.com/auth":{"chatgpt_plan_type":"pro"}}"#,
        );
        let auth = format!(
            r#"{{"auth_mode":"chatgpt","tokens":{{"account_id":"workspace-1","id_token":"header.{claims}.signature"}}}}"#
        );

        let account = parse_auth_account(auth.as_bytes()).expect("account should be parsed");

        assert_eq!(account.account_type, "chatgpt");
        assert_eq!(account.email.as_deref(), Some("one@example.com"));
        assert_eq!(account.plan_type.as_deref(), Some("pro"));
        assert_eq!(account.token_account_id.as_deref(), Some("workspace-1"));
    }
}
