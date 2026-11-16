// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, path::Path, process::Command};

use wegent_executor::local::native_git::clear_local_git_env;

pub struct GitCloneFixture {
    pub directory: tempfile::TempDir,
    pub env: HashMap<String, String>,
}

impl GitCloneFixture {
    pub fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        assert_ne!(
            directory.path().canonicalize().unwrap(),
            std::env::current_dir().unwrap().canonicalize().unwrap()
        );
        let config = directory.path().join("gitconfig");
        std::fs::write(&config, "").unwrap();
        let fixture = Self {
            directory,
            env: HashMap::from([
                ("GIT_CONFIG_GLOBAL".into(), config.display().to_string()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ]),
        };
        fixture.git(
            fixture.directory.path(),
            &["init", "--initial-branch=main", "source"],
        );
        let source = fixture.directory.path().join("source");
        std::fs::write(source.join("README.md"), "Caller workspace checkout\n").unwrap();
        fixture.git(&source, &["add", "README.md"]);
        fixture.git(
            &source,
            &[
                "-c",
                "user.name=Git clone fixture",
                "-c",
                "user.email=clone@example.invalid",
                "commit",
                "-m",
                "test: seed caller workspace",
            ],
        );
        fixture
    }

    pub fn args(&self, relative_source: bool) -> Vec<String> {
        let source = if relative_source {
            "source".into()
        } else {
            self.directory.path().join("source").display().to_string()
        };
        vec![
            "--branch".into(),
            "main".into(),
            "--single-branch".into(),
            source,
            "checkout".into(),
        ]
    }

    pub fn git(&self, cwd: &Path, args: &[&str]) -> String {
        let mut command = Command::new("git");
        clear_local_git_env(&mut command);
        let output = command
            .envs(&self.env)
            .args(["-c", "core.hooksPath="])
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {output:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    pub fn assert_checkout(&self) {
        let checkout = self.directory.path().join("checkout");
        assert_eq!(
            std::fs::read_to_string(checkout.join("README.md")).unwrap(),
            "Caller workspace checkout\n"
        );
        assert_eq!(self.git(&checkout, &["branch", "--show-current"]), "main");
        assert_eq!(
            self.git(&checkout, &["rev-parse", "HEAD"]),
            self.git(
                &self.directory.path().join("source"),
                &["rev-parse", "HEAD"]
            )
        );
    }
}
