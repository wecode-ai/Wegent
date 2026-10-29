//! Python readiness for trusted local authentication commands.

use super::*;

pub(super) async fn prepare_command(
    root: &Path,
    args: &[String],
    tool: Option<&Path>,
) -> Result<bool, AppIpcError> {
    let python_program = args
        .first()
        .is_some_and(|program| crate::python_runtime::is_python_program(program));
    let python_tool = tool.is_some_and(|tool| {
        tool.to_str()
            .is_some_and(crate::python_runtime::is_python_program)
    });
    if !crate::python_runtime::managed_python_bridge_configured() {
        return Ok(python_program || python_tool);
    }
    let requires_python = python_program
        || python_tool
        || (!args.is_empty() && command_requires_python(&read_plugin_manifest(root)?, args));
    if requires_python {
        crate::python_runtime::ensure_managed_python()
            .await
            .map_err(|message| AppIpcError::new("python_runtime_unavailable", message))?;
    }
    Ok(requires_python)
}

fn command_requires_python(manifest: &Value, args: &[String]) -> bool {
    let Some(program) = args.first() else {
        return false;
    };
    if crate::python_runtime::is_python_program(program) {
        return true;
    }
    manifest["connectors"].as_array().is_some_and(|connectors| {
        connectors.iter().any(|connector| {
            let python_adapter = connector["accountAuth"]["adapter"]
                .as_str()
                .is_some_and(|adapter| adapter.to_ascii_lowercase().ends_with(".py"));
            python_adapter
                && ["health", "start", "poll", "logout"].iter().any(|action| {
                    connector["localAuth"][action][0].as_str() == Some(program.as_str())
                })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_readiness_covers_declared_shell_wrappers_without_gating_native_connectors() {
        let manifest = json!({"connectors": [
            {"slug": "email", "accountAuth": {"adapter": "scripts/account_auth.py"},
             "localAuth": {
                 "health": ["scripts/email.sh", "health"],
                 "start": ["scripts/email.sh", "login"],
                 "poll": ["scripts/email.ps1", "status"],
                 "logout": ["scripts/email.sh", "logout"]}},
            {"slug": "native", "accountAuth": {"adapter": "bin/native"},
             "localAuth": {"health": ["scripts/native.sh", "status"]}}
        ]});
        for program in [
            "scripts/email.sh",
            "scripts/email.ps1",
            "python3",
            "auth.py",
        ] {
            assert!(command_requires_python(&manifest, &[program.to_owned()]));
        }
        for program in ["scripts/native.sh", "scripts/unrelated.sh", "dws", "glab"] {
            assert!(!command_requires_python(&manifest, &[program.to_owned()]));
        }
        assert!(!command_requires_python(&manifest, &[]));
    }

    #[test]
    fn shell_wrappers_require_an_explicit_python_adapter_and_a_matching_command() {
        for adapter in [
            Value::Null,
            json!("scripts/native"),
            json!({"path": "auth.py"}),
        ] {
            let manifest = json!({"connectors": [{
                "accountAuth": {"adapter": adapter},
                "localAuth": {"health": ["scripts/status.sh"]}
            }]});
            assert!(!command_requires_python(
                &manifest,
                &["scripts/status.sh".to_owned()]
            ));
        }
    }
}
