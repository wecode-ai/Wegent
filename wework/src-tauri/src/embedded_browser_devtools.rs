use std::{
    ffi::c_void,
    sync::OnceLock,
    time::{Duration, Instant},
};

use objc2::{
    ffi::{objc_setAssociatedObject, OBJC_ASSOCIATION_RETAIN_NONATOMIC},
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
    sel,
};
use objc2_app_kit::NSView;
use serde_json::{json, Value};
use tauri::{Webview, Wry};

static INSPECTOR_DELEGATE_KEY: u8 = 0;
const INSPECTOR_E2E_TIMEOUT: Duration = Duration::from_secs(10);
const INSPECTOR_E2E_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy)]
struct NativeInspectorState {
    frame: [f64; 4],
    visible: bool,
    window_count: usize,
}

unsafe extern "C-unwind" fn inspector_frontend_loaded(
    _delegate: &AnyObject,
    _command: Sel,
    inspector: *mut AnyObject,
) {
    if inspector.is_null() {
        return;
    }
    let webview: *mut NSView = unsafe { msg_send![&*inspector, webView] };
    let frame = unsafe { webview.as_ref().map(NSView::frame) };
    let _: () = unsafe { msg_send![&*inspector, detach] };
    if let (Some(webview), Some(frame)) = (unsafe { webview.as_ref() }, frame) {
        webview.setFrame(frame);
    }
}

fn inspector_delegate_class() -> Result<&'static AnyClass, String> {
    static CLASS: OnceLock<Result<&'static AnyClass, String>> = OnceLock::new();
    CLASS
        .get_or_init(|| {
            if let Some(class) = AnyClass::get(c"WegentEmbeddedBrowserInspectorDelegate") {
                return Ok(class);
            }
            let superclass =
                AnyClass::get(c"NSObject").ok_or_else(|| "NSObject is unavailable".to_string())?;
            let mut builder =
                ClassBuilder::new(c"WegentEmbeddedBrowserInspectorDelegate", superclass)
                    .ok_or_else(|| {
                        "Failed to allocate embedded browser Inspector delegate class".to_string()
                    })?;
            unsafe {
                builder.add_method(
                    sel!(inspectorFrontendLoaded:),
                    inspector_frontend_loaded as unsafe extern "C-unwind" fn(_, _, _),
                );
            }
            Ok(builder.register())
        })
        .clone()
}

unsafe fn install_detached_inspector(webview: *mut AnyObject) -> Result<(), String> {
    let inspector = unsafe { native_inspector(webview)? };
    let supports_delegate: bool =
        unsafe { msg_send![&*inspector, respondsToSelector: sel!(setDelegate:)] };
    let supports_detach: bool = unsafe { msg_send![&*inspector, respondsToSelector: sel!(detach)] };
    if !supports_delegate || !supports_detach {
        return Err("Detached embedded browser Inspector is unavailable".to_string());
    }
    let existing_delegate: *mut AnyObject = unsafe { msg_send![&*inspector, delegate] };
    if !existing_delegate.is_null() {
        return Err("Embedded browser Inspector already has a delegate".to_string());
    }

    let class = inspector_delegate_class()?;
    let delegate: Retained<AnyObject> = unsafe { msg_send![class, new] };
    unsafe {
        objc_setAssociatedObject(
            Retained::as_ptr(&inspector).cast_mut(),
            std::ptr::addr_of!(INSPECTOR_DELEGATE_KEY).cast::<c_void>(),
            Retained::as_ptr(&delegate).cast_mut(),
            OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        let _: () = msg_send![&*inspector, setDelegate: &*delegate];
    }
    Ok(())
}

unsafe fn native_inspector(webview: *mut AnyObject) -> Result<Retained<AnyObject>, String> {
    if webview.is_null() {
        return Err("Embedded browser native WebView is unavailable".to_string());
    }
    let webview = unsafe { &*webview };
    let has_inspector: bool = unsafe { msg_send![webview, respondsToSelector: sel!(_inspector)] };
    if !has_inspector {
        return Err("Embedded browser Inspector is unavailable".to_string());
    }
    let inspector: Option<Retained<AnyObject>> = unsafe { msg_send![webview, _inspector] };
    inspector.ok_or_else(|| "Embedded browser Inspector is unavailable".to_string())
}

unsafe fn read_native_inspector_state(
    webview: *mut AnyObject,
) -> Result<NativeInspectorState, String> {
    let inspector = unsafe { native_inspector(webview)? };
    let supports_visible: bool =
        unsafe { msg_send![&*inspector, respondsToSelector: sel!(isVisible)] };
    if !supports_visible {
        return Err("Embedded browser Inspector state is unavailable".to_string());
    }
    let visible: bool = unsafe { msg_send![&*inspector, isVisible] };
    let frame = unsafe { (&*webview.cast::<NSView>()).frame() };
    let application_class = AnyClass::get(c"NSApplication")
        .ok_or_else(|| "NSApplication is unavailable".to_string())?;
    let application: Retained<AnyObject> =
        unsafe { msg_send![application_class, sharedApplication] };
    let windows: Retained<AnyObject> = unsafe { msg_send![&*application, windows] };
    let window_count: usize = unsafe { msg_send![&*windows, count] };
    Ok(NativeInspectorState {
        frame: [
            frame.origin.x,
            frame.origin.y,
            frame.size.width,
            frame.size.height,
        ],
        visible,
        window_count,
    })
}

unsafe fn show_native_inspector(webview: *mut AnyObject) -> Result<(), String> {
    let inspector = unsafe { native_inspector(webview)? };
    let supports_show: bool = unsafe { msg_send![&*inspector, respondsToSelector: sel!(show)] };
    if !supports_show {
        return Err("Embedded browser Inspector cannot be shown".to_string());
    }
    let _: () = unsafe { msg_send![&*inspector, show] };
    Ok(())
}

unsafe fn close_native_inspector(webview: *mut AnyObject) -> Result<(), String> {
    let inspector = unsafe { native_inspector(webview)? };
    let supports_close: bool = unsafe { msg_send![&*inspector, respondsToSelector: sel!(close)] };
    if !supports_close {
        return Err("Embedded browser Inspector cannot be closed".to_string());
    }
    let _: () = unsafe { msg_send![&*inspector, close] };
    Ok(())
}

async fn inspector_state(webview: &Webview<Wry>) -> Result<NativeInspectorState, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                read_native_inspector_state(platform_webview.inner().cast::<AnyObject>())
            };
            let _ = sender.try_send(result);
        })
        .map_err(|error| format!("Failed to inspect embedded browser Inspector: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "Embedded browser Inspector state request was cancelled".to_string())?
}

async fn set_inspector_visibility(webview: &Webview<Wry>, visible: bool) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform_webview| {
            let webview = platform_webview.inner().cast::<AnyObject>();
            let result = unsafe {
                if visible {
                    show_native_inspector(webview)
                } else {
                    close_native_inspector(webview)
                }
            };
            let _ = sender.try_send(result);
        })
        .map_err(|error| format!("Failed to update embedded browser Inspector: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "Embedded browser Inspector visibility request was cancelled".to_string())?
}

pub async fn register_detached_inspector(webview: &Webview<Wry>) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform_webview| {
            let result =
                unsafe { install_detached_inspector(platform_webview.inner().cast::<AnyObject>()) };
            let _ = sender.try_send(result);
        })
        .map_err(|error| format!("Failed to configure detached browser Inspector: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "Detached browser Inspector registration was cancelled".to_string())?
}

pub async fn verify_detached_inspector_for_e2e(webview: &Webview<Wry>) -> Result<Value, String> {
    let before = inspector_state(webview).await?;
    set_inspector_visibility(webview, true).await?;

    let started_at = Instant::now();
    let after = loop {
        let state = inspector_state(webview).await?;
        if state.visible && state.window_count > before.window_count {
            break state;
        }
        if started_at.elapsed() >= INSPECTOR_E2E_TIMEOUT {
            let _ = set_inspector_visibility(webview, false).await;
            return Err("Timed out waiting for detached embedded browser Inspector".to_string());
        }
        tokio::time::sleep(INSPECTOR_E2E_POLL_INTERVAL).await;
    };

    set_inspector_visibility(webview, false).await?;
    let closed_started_at = Instant::now();
    let closed = loop {
        let state = inspector_state(webview).await?;
        if !state.visible {
            break state;
        }
        if closed_started_at.elapsed() >= INSPECTOR_E2E_TIMEOUT {
            return Err("Timed out closing detached embedded browser Inspector".to_string());
        }
        tokio::time::sleep(INSPECTOR_E2E_POLL_INTERVAL).await;
    };
    Ok(json!({
        "beforeFrame": before.frame,
        "afterFrame": after.frame,
        "visible": after.visible,
        "beforeWindowCount": before.window_count,
        "afterWindowCount": after.window_count,
        "closedVisible": closed.visible,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspector_delegate_handles_frontend_loaded() {
        let class = inspector_delegate_class().expect("Inspector delegate class should register");
        assert!(class
            .instance_method(sel!(inspectorFrontendLoaded:))
            .is_some());
    }
}
