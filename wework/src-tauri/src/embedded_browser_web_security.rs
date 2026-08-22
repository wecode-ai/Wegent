use objc2::{msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::NSString;
use tauri::{Webview, Wry};

const WEB_SECURITY_ENABLED_KEY: &str = "webSecurityEnabled";

pub async fn disable_web_security(webview: &Webview<Wry>) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let webview = platform_webview.inner().cast::<AnyObject>();
            let configuration: Retained<AnyObject> = msg_send![&*webview, configuration];
            let preferences: Retained<AnyObject> = msg_send![&*configuration, preferences];
            let number_class =
                objc2::runtime::AnyClass::get(c"NSNumber").expect("NSNumber must exist on macOS");
            let disabled: Retained<AnyObject> = msg_send![number_class, numberWithBool: false];
            let key = NSString::from_str(WEB_SECURITY_ENABLED_KEY);
            let _: () = msg_send![&*preferences, setValue: &*disabled, forKey: &*key];
            let configured: Retained<AnyObject> = msg_send![&*preferences, valueForKey: &*key];
            let enabled: bool = msg_send![&*configured, boolValue];
            let _ = sender.try_send(
                (!enabled)
                    .then_some(())
                    .ok_or_else(|| "WKWebView refused to disable web security".to_string()),
            );
        })
        .map_err(|error| format!("Failed to configure Harness web security: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "Harness web security configuration was cancelled".to_string())?
}
