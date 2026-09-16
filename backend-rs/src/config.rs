//! Application configuration loaded from the source-compatible environment.
//!
//! Ported from the reference implementation's `src/config.rs`. The source reads
//! these values through `app.core.config.settings` (pydantic `BaseSettings`)
//! from the process environment and a dotenv file. The target reads the same
//! names with dotenv-compatible parsing, preferring the process environment.
//! The dotenv file defaults to `config/example.env` and is redirected with
//! `WEGENT_ENV_FILE`.
//!
//! One deliberate difference: the reference also exposes `init_env`, which
//! exports every dotenv entry into the process environment with
//! `env::set_var`. That call is `unsafe` in edition 2024 and this crate
//! forbids `unsafe`, so it is not ported. Every value this crate owns is read
//! through [`env_or_dotenv`], which performs the dotenv lookup itself, so the
//! observable configuration is unchanged.

use std::env;
use std::sync::OnceLock;

/// JWT configuration (`settings.SECRET_KEY`,
/// `settings.JWT_LEGACY_SECRET_KEYS`, `settings.ALGORITHM`).
#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// Active JWT signing key.
    pub jwt_key: String,
    /// Legacy decode-only keys (may be empty).
    pub legacy_jwt_keys: Vec<String>,
    /// JWT algorithm name (`HS256`).
    pub algorithm: String,
}

/// Database configuration (`settings.DATABASE_URL`).
#[derive(Debug, Clone)]
pub struct DatabaseConfig {
    /// Raw source-compatible `mysql+pymysql://...` URL.
    pub url: String,
}

/// Errors while resolving configuration.
#[derive(Debug)]
pub enum ConfigError {
    /// A required variable is missing or empty.
    Missing(&'static str),
    /// A required variable is present but malformed.
    Invalid(&'static str),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(name) => write!(formatter, "{name} is required"),
            Self::Invalid(name) => write!(formatter, "{name} is invalid"),
        }
    }
}

impl std::error::Error for ConfigError {}

/// Applies dotenv value semantics: strip one pair of matching outer quotes.
fn dotenv_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// Default dotenv path, relative to the process working directory. Both
/// backends ship `config/example.env`, so a run from the crate root (or from
/// the container's `/app`) resolves it without configuration.
const DEFAULT_ENV_FILE: &str = "config/example.env";

/// The dotenv path chosen at startup by [`init_env_file`]; unset until then.
static ENV_FILE: OnceLock<String> = OnceLock::new();

/// Resolves the dotenv path: `--env-file`, then `WEGENT_ENV_FILE`, then the
/// default.
///
/// A blank value is treated as absent, so an empty argument or an
/// exported-but-empty variable does not silently disable the next source.
fn resolve_env_file(flag: Option<String>, from_env: Option<String>) -> String {
    [flag, from_env]
        .into_iter()
        .flatten()
        .find(|path| !path.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ENV_FILE.to_string())
}

/// Reads `--env-file <path>` (also `--env-file=<path>`) from an argument list.
fn env_file_arg(mut args: impl Iterator<Item = String>) -> Option<String> {
    while let Some(argument) = args.next() {
        if let Some(value) = argument.strip_prefix("--env-file=") {
            return Some(value.to_string());
        }
        if argument == "--env-file" {
            return args.next();
        }
    }
    None
}

/// Chooses the dotenv path for this process from the command line and the
/// environment.
///
/// Call once at startup, before any configuration is read. Later calls are
/// ignored, and a process that never calls it still resolves the path on
/// demand.
pub fn init_env_file() {
    let _ = ENV_FILE.set(resolve_env_file(
        env_file_arg(env::args().skip(1)),
        env::var("WEGENT_ENV_FILE").ok(),
    ));
}

/// The dotenv file consulted when a variable is absent from the process
/// environment.
fn dotenv_path() -> String {
    ENV_FILE
        .get()
        .cloned()
        .unwrap_or_else(|| resolve_env_file(None, env::var("WEGENT_ENV_FILE").ok()))
}

/// Looks up one key in a dotenv file's contents.
fn read_dotenv(content: &str, name: &str) -> Option<String> {
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == name {
            let value = dotenv_value(raw_value);
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/// Reads one variable from the process environment, falling back to the
/// dotenv file at [`dotenv_path`].
///
/// A blank process-environment value is treated as absent, matching the
/// source's pydantic settings precedence where an empty value does not
/// override the dotenv default.
#[must_use]
pub fn env_or_dotenv(name: &str) -> Option<String> {
    if let Ok(value) = env::var(name)
        && !value.trim().is_empty()
    {
        return Some(value);
    }
    let content = std::fs::read_to_string(dotenv_path()).ok()?;
    read_dotenv(&content, name)
}

/// Splits `JWT_LEGACY_SECRET_KEYS` the way the source does: a
/// comma-separated list whose blank entries are dropped. Deduplication
/// against the active key happens in [`crate::auth`].
fn parse_legacy_keys(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .collect()
}

impl AuthConfig {
    /// Reads the source-compatible JWT configuration.
    ///
    /// The active key falls back to the pydantic default because the source
    /// does not fail startup when it is absent.
    #[must_use]
    pub fn from_env() -> Self {
        let jwt_key = env_or_dotenv("SECRET_KEY").unwrap_or_else(|| "secret-key".to_string());
        let legacy_jwt_keys = env_or_dotenv("JWT_LEGACY_SECRET_KEYS")
            .map(|value| parse_legacy_keys(&value))
            .unwrap_or_default();
        let algorithm = env_or_dotenv("ALGORITHM").unwrap_or_else(|| "HS256".to_string());
        Self {
            jwt_key,
            legacy_jwt_keys,
            algorithm,
        }
    }
}

impl DatabaseConfig {
    /// Reads the source-compatible `DATABASE_URL`.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError::Missing`] when `DATABASE_URL` is neither in the
    /// process environment nor in the dotenv file.
    pub fn from_env() -> Result<Self, ConfigError> {
        let url = env_or_dotenv("DATABASE_URL").ok_or(ConfigError::Missing("DATABASE_URL"))?;
        Ok(Self { url })
    }

    /// Converts the SQLAlchemy `mysql+pymysql://` scheme to the plain
    /// `mysql://` scheme used by the target driver.
    ///
    /// The source driver (PyMySQL via SQLAlchemy) does not negotiate TLS by
    /// default, so the target also connects in plaintext: `ssl-mode=disabled`
    /// keeps the driver default (`Preferred`) from upgrading the connection to
    /// TLS when the server offers it.
    #[must_use]
    pub fn mysql_url(&self) -> String {
        let base = if let Some(rest) = self.url.strip_prefix("mysql+pymysql://") {
            format!("mysql://{rest}")
        } else {
            self.url.clone()
        };
        match base.split_once('?') {
            Some((_head, query)) if query.contains("ssl-mode=") => base,
            Some((head, query)) => format!("{head}?{query}&ssl-mode=disabled"),
            None => format!("{base}?ssl-mode=disabled"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_the_sqlalchemy_scheme_and_disables_tls() {
        let config = DatabaseConfig {
            url: "mysql+pymysql://user:pw@host:7831/task_manager".to_string(),
        };
        assert_eq!(
            config.mysql_url(),
            "mysql://user:pw@host:7831/task_manager?ssl-mode=disabled"
        );
    }

    #[test]
    fn keeps_an_existing_query_and_an_explicit_ssl_mode() {
        let with_query = DatabaseConfig {
            url: "mysql+pymysql://user:pw@host:7831/db?charset=utf8mb4".to_string(),
        };
        assert_eq!(
            with_query.mysql_url(),
            "mysql://user:pw@host:7831/db?charset=utf8mb4&ssl-mode=disabled"
        );

        let explicit = DatabaseConfig {
            url: "mysql://user:pw@host:7831/db?ssl-mode=required".to_string(),
        };
        assert_eq!(
            explicit.mysql_url(),
            "mysql://user:pw@host:7831/db?ssl-mode=required"
        );
    }

    #[test]
    fn strips_one_pair_of_matching_quotes() {
        assert_eq!(dotenv_value("'abc'"), "abc");
        assert_eq!(dotenv_value("\"abc\""), "abc");
        assert_eq!(dotenv_value("  abc  "), "abc");
        assert_eq!(dotenv_value("'abc\""), "'abc\"");
        assert_eq!(dotenv_value("\"abc"), "\"abc");
        assert_eq!(dotenv_value(""), "");
    }

    #[test]
    fn unset_variables_have_no_dotenv_value() {
        assert_eq!(env_or_dotenv("WEGENT_BACKEND_RS_TEST_UNSET_VARIABLE"), None);
    }

    #[test]
    fn env_file_precedence_is_flag_then_variable_then_default() {
        assert_eq!(
            resolve_env_file(Some("flag.env".to_owned()), Some("var.env".to_owned())),
            "flag.env"
        );
        assert_eq!(
            resolve_env_file(None, Some("var.env".to_owned())),
            "var.env"
        );
        assert_eq!(resolve_env_file(None, None), DEFAULT_ENV_FILE);
        // A blank value falls through instead of disabling the lookup.
        assert_eq!(
            resolve_env_file(Some("  ".to_owned()), Some("var.env".to_owned())),
            "var.env"
        );
        assert_eq!(
            resolve_env_file(Some(String::new()), None),
            DEFAULT_ENV_FILE
        );
    }

    #[test]
    fn parses_the_env_file_argument() {
        let parse = |args: &[&str]| env_file_arg(args.iter().map(|arg| (*arg).to_owned()));
        assert_eq!(
            parse(&["--env-file", "/tmp/a.env"]),
            Some("/tmp/a.env".to_owned())
        );
        assert_eq!(
            parse(&["--env-file=/tmp/a.env"]),
            Some("/tmp/a.env".to_owned())
        );
        assert_eq!(
            parse(&["--other", "--env-file", "b.env"]),
            Some("b.env".to_owned())
        );
        // A trailing flag without a value is ignored.
        assert_eq!(parse(&["--env-file"]), None);
        assert_eq!(parse(&[]), None);
    }

    #[test]
    fn reads_keys_from_dotenv_contents() {
        let content = "\
# comment
DATABASE_URL=mysql+pymysql://user:pw@host:3306/db
QUOTED='single'
DOUBLE=\"double\"
EMPTY=
SPACED  =  padded
";
        assert_eq!(
            read_dotenv(content, "DATABASE_URL"),
            Some("mysql+pymysql://user:pw@host:3306/db".to_owned())
        );
        assert_eq!(read_dotenv(content, "QUOTED"), Some("single".to_owned()));
        assert_eq!(read_dotenv(content, "DOUBLE"), Some("double".to_owned()));
        assert_eq!(read_dotenv(content, "SPACED"), Some("padded".to_owned()));
        // An empty value is not a value, matching `env_or_dotenv`.
        assert_eq!(read_dotenv(content, "EMPTY"), None);
        assert_eq!(read_dotenv(content, "ABSENT"), None);
    }

    #[test]
    fn auth_config_splits_legacy_keys() {
        assert_eq!(parse_legacy_keys(" a , ,b, a "), ["a", "b", "a"]);
        assert_eq!(parse_legacy_keys(""), Vec::<String>::new());
    }
}
