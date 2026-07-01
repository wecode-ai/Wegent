// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliArgs {
    pub version: bool,
    pub upgrade: bool,
    pub yes: bool,
    pub verbose: bool,
    pub help: bool,
    pub config_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliError {
    MissingValue(&'static str),
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingValue(flag) => write!(formatter, "{flag} requires a value"),
        }
    }
}

impl CliArgs {
    pub fn parse_from<I, S>(args: I) -> Result<Self, CliError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut parsed = Self {
            version: false,
            upgrade: false,
            yes: false,
            verbose: false,
            help: false,
            config_path: None,
        };

        let mut iter = args.into_iter().map(Into::into);
        let _program = iter.next();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--version" | "-v" => parsed.version = true,
                "--upgrade" => parsed.upgrade = true,
                "--yes" | "-y" => parsed.yes = true,
                "--verbose" => parsed.verbose = true,
                "--help" | "-h" => parsed.help = true,
                "--config" => {
                    let value = iter.next().ok_or(CliError::MissingValue("--config"))?;
                    if value.starts_with('-') {
                        return Err(CliError::MissingValue("--config"));
                    }
                    parsed.config_path = Some(value);
                }
                _ => {}
            }
        }

        Ok(parsed)
    }

    pub fn usage() -> &'static str {
        "Wegent Executor\n\nUsage: wegent-executor [--version] [--upgrade] [--config <path>]\n\nOptions:\n  -v, --version       Print version and exit\n      --upgrade       Check for updates and upgrade\n  -y, --yes           Auto-confirm upgrade\n      --verbose       Enable verbose upgrade logging\n      --config PATH   Device config path\n  -h, --help          Show this help message"
    }
}
