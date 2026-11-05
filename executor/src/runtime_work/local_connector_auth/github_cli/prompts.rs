//! Parse only known CLI prompts; never expose arbitrary authentication output.
use super::*;

fn device_code(text: &str) -> Option<&str> {
    let code = text
        .split_once("First copy your one-time code: ")
        .map(|(_, code)| code.trim())
        .or_else(|| {
            text.split_once("One-time code (")
                .and_then(|(_, tail)| tail.split_once(") copied to clipboard"))
                .filter(|(_, suffix)| suffix.trim().is_empty())
                .map(|(code, _)| code)
        })?;
    (code.len() == 9
        && code.as_bytes()[4] == b'-'
        && code
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || byte.is_ascii_uppercase() || byte.is_ascii_digit()))
    .then_some(code)
}

pub(super) fn apply_prompt(line: &[u8], state: &mut Value) -> Result<(), &'static str> {
    let text = crate::process_environment::strip_ansi_codes(&String::from_utf8_lossy(line));
    if let Some(code) = device_code(&text) {
        state["userCode"] = json!(code);
    }
    let Some((_, address)) = text.split_once("to continue in your web browser: ") else {
        return Ok(());
    };
    let address = address.trim();
    let Ok(url) = url::Url::parse(address) else {
        return Err("gh_login_prompt_invalid");
    };
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "/login/device" | "/login/oauth/authorize")
    {
        return Err("gh_login_prompt_invalid");
    }
    // gh prints its code before the device URL. A URL alone cannot complete
    // device authorization. The OAuth redirect flow does not require a code.
    if url.path() == "/login/device" && state["userCode"].as_str().is_none() {
        return Err("gh_login_code_missing");
    }
    state["verificationUrl"] = json!(address);
    state["status"] = json!("waiting_browser");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_plain_clipboard_and_formatted_device_prompts() {
        for line in [
            "! First copy your one-time code: ABCD-1234",
            "! One-time code (ABCD-1234) copied to clipboard",
            "\x1b[33m!\x1b[0m First copy your one-time code: \x1b[1mABCD-1234\x1b[0m\r",
            "! One-time code (\x1b[1mABCD-1234\x1b[0m) copied to clipboard",
        ] {
            let mut state = json!({"status": "preparing", "sessionId": "test"});
            apply_prompt(line.as_bytes(), &mut state).unwrap();
            assert_eq!(state["status"], "preparing");
            apply_prompt(
                b"Open this URL to continue in your web browser: https://github.com/login/device",
                &mut state,
            )
            .unwrap();
            assert_eq!(state["userCode"], "ABCD-1234");
            assert_eq!(state["status"], "waiting_browser");
            assert_eq!(state["sessionId"], "test");
        }
    }

    #[test]
    fn missing_or_invalid_codes_never_allow_device_authorization() {
        for line in [
            "Token: ABCD-1234",
            "! First copy your one-time code: SECRET",
            "! First copy your one-time code: abcd-1234",
            "! First copy your one-time code: ABCD-12345",
        ] {
            let mut state = json!({"status": "preparing"});
            apply_prompt(line.as_bytes(), &mut state).unwrap();
            assert_eq!(apply_prompt(b"Open this URL to continue in your web browser: https://github.com/login/device", &mut state), Err("gh_login_code_missing"));
            assert!(state["verificationUrl"].is_null());
            assert!(state["userCode"].is_null());
            assert_eq!(state["status"], "preparing");
        }
    }

    #[test]
    fn oauth_redirect_does_not_require_a_device_code() {
        let mut state = json!({"status": "preparing"});
        apply_prompt(b"Open this URL to continue in your web browser: https://github.com/login/oauth/authorize?client_id=fixture", &mut state).unwrap();
        assert_eq!(state["status"], "waiting_browser");
    }

    #[test]
    fn rejects_untrusted_urls() {
        for address in [
            "https://github.com.evil/login/device",
            "https://user@github.com/login/device",
            "https://github.com/settings/tokens",
            "https://github.com:8443/login/device",
            "http://github.com/login/device",
        ] {
            let mut state = json!({"status":"preparing", "userCode":"ABCD-1234"});
            let line = format!("Open this URL to continue in your web browser: {address}");
            assert_eq!(
                apply_prompt(line.as_bytes(), &mut state),
                Err("gh_login_prompt_invalid")
            );
            assert!(state["verificationUrl"].is_null());
        }
    }
}
