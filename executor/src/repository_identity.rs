// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{fs, path::Path};

use sha2::{Digest, Sha256};
use url::Url;

/// A repository key describes the Git source, not a task or local checkout.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RepositoryIdentity {
    pub name: String,
    pub digest: String,
}

impl RepositoryIdentity {
    pub fn from_url(raw: &str) -> Result<Self, String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err("Git repository address is required".into());
        }
        let url = if raw.contains("://") {
            Url::parse(raw).map_err(|_| "Invalid Git repository address")?
        } else if !Path::new(raw).is_absolute() && raw.contains(':') {
            let (host, path) = raw.split_once(':').unwrap();
            Url::parse(&format!("ssh://{host}/{path}"))
                .map_err(|_| "Invalid Git repository address")?
        } else {
            return Self::local(Path::new(raw));
        };
        if url.scheme() == "file" {
            return Self::local(&url.to_file_path().map_err(|_| "Invalid local Git source")?);
        }
        if !matches!(url.scheme(), "http" | "https" | "ssh" | "git") {
            return Err("Unsupported Git repository address".into());
        }
        let host = url
            .host_str()
            .ok_or("Git service host is required")?
            .to_ascii_lowercase();
        let path = url.path().trim_end_matches('/');
        let path = path.strip_suffix(".git").unwrap_or(path);
        let name = path
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .ok_or("Git repository path is required")?;
        let port = url
            .port()
            .filter(|port| !matches!((url.scheme(), *port), ("ssh", 22) | ("git", 9418)));
        let service = match port {
            Some(port) => format!("{host}:{port}"),
            None => host,
        };
        // Userinfo, query tokens and transport are not repository identity.
        Ok(Self::new(name, &format!("remote:{service}{path}")))
    }

    fn local(path: &Path) -> Result<Self, String> {
        let path = fs::canonicalize(path).map_err(|_| "Local Git source is unavailable")?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid local Git source")?;
        Ok(Self::new(
            name.strip_suffix(".git").unwrap_or(name),
            &format!("file:{}", path.display()),
        ))
    }

    fn new(name: &str, source: &str) -> Self {
        let name: String = name
            .chars()
            .take(64)
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                    ch
                } else {
                    '-'
                }
            })
            .collect();
        let name = name.trim_matches('.');
        Self {
            name: if name.is_empty() { "repository" } else { name }.to_owned(),
            digest: format!("{:x}", Sha256::digest(source.as_bytes())),
        }
    }

    pub fn key(&self, length: usize) -> String {
        format!("{}-{}", self.name, &self.digest[..length])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_key_uses_host_and_full_path_without_credentials_or_transport() {
        let expected = RepositoryIdentity::from_url("https://git.example/team/demo.git").unwrap();
        for url in [
            "ssh://git@git.example:22/team/demo",
            "git@git.example:team/demo.git",
            "https://user:secret@GIT.EXAMPLE:443/team/demo.git?token=secret",
            "http://git.example/team/demo/",
        ] {
            assert_eq!(RepositoryIdentity::from_url(url).unwrap(), expected);
        }
        assert_eq!(expected.key(8).len(), "demo-".len() + 8);
        for url in [
            "https://other.example/team/demo",
            "https://git.example/other/demo",
            "https://git.example/Team/demo",
            "ssh://git.example:2222/team/demo",
            "https://git.example/team%2Fother/demo",
            "https://git.example/team/other/demo",
        ] {
            assert_ne!(RepositoryIdentity::from_url(url).unwrap(), expected);
        }
        assert_ne!(
            RepositoryIdentity::from_url("https://git.example/team%2Fother/demo").unwrap(),
            RepositoryIdentity::from_url("https://git.example/team/other/demo").unwrap()
        );
    }

    #[test]
    fn repository_key_handles_local_sources_and_safe_directory_names() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("demo.git");
        fs::create_dir(&source).unwrap();
        let identity = RepositoryIdentity::from_url(source.to_str().unwrap()).unwrap();
        assert_eq!(
            identity,
            RepositoryIdentity::from_url(Url::from_file_path(&source).unwrap().as_str()).unwrap()
        );
        assert_eq!(identity.name, "demo");
        let escaped = RepositoryIdentity::from_url("https://git.example/team/demo%2Fother.git")
            .unwrap()
            .key(8);
        assert!(!escaped.contains(['/', '%', '\\']));
        assert!(RepositoryIdentity::from_url("https://git.example/").is_err());
    }
}
