use std::{
    collections::HashMap,
    ffi::{c_char, c_void},
    sync::{Mutex, Once, OnceLock},
};

use block2::Block;
use objc2::{
    ffi::{class_addMethod, class_getInstanceMethod, object_getClass},
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel,
};
use objc2_foundation::NSString;
use tauri::{Emitter, Webview, Wry};

use crate::embedded_browser::EmbeddedBrowserInvalidTlsCertificate;

const INVALID_TLS_CERTIFICATE_EVENT: &str = "wework:embedded-browser-invalid-tls-certificate";
const AUTH_CHALLENGE_USE_CREDENTIAL: isize = 0;
const AUTH_CHALLENGE_PERFORM_DEFAULT_HANDLING: isize = 1;
const SERVER_TRUST_AUTHENTICATION_METHOD: &str = "NSURLAuthenticationMethodServerTrust";

type AuthenticationChallengeCompletion = Block<dyn Fn(isize, *mut AnyObject)>;

#[derive(Clone)]
struct InvalidTlsWebviewContext {
    app: tauri::AppHandle,
    native_label: String,
}

fn webview_contexts() -> &'static Mutex<HashMap<usize, InvalidTlsWebviewContext>> {
    static CONTEXTS: OnceLock<Mutex<HashMap<usize, InvalidTlsWebviewContext>>> = OnceLock::new();
    CONTEXTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn invalid_tls_certificates(
) -> &'static Mutex<HashMap<String, EmbeddedBrowserInvalidTlsCertificate>> {
    static CERTIFICATES: OnceLock<Mutex<HashMap<String, EmbeddedBrowserInvalidTlsCertificate>>> =
        OnceLock::new();
    CERTIFICATES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecTrustEvaluateWithError(trust: *const c_void, error: *mut *mut c_void) -> bool;
}

unsafe extern "C-unwind" fn handle_authentication_challenge(
    _delegate: *mut AnyObject,
    _command: Sel,
    webview: *mut AnyObject,
    challenge: *mut AnyObject,
    completion: *mut AuthenticationChallengeCompletion,
) {
    if webview.is_null() || challenge.is_null() || completion.is_null() {
        return;
    }

    let challenge = unsafe { &*challenge };
    let protection_space: Retained<AnyObject> = unsafe { msg_send![challenge, protectionSpace] };
    let authentication_method: Retained<NSString> =
        unsafe { msg_send![&*protection_space, authenticationMethod] };
    if authentication_method.to_string() != SERVER_TRUST_AUTHENTICATION_METHOD {
        unsafe {
            (*completion).call((
                AUTH_CHALLENGE_PERFORM_DEFAULT_HANDLING,
                std::ptr::null_mut(),
            ));
        }
        return;
    }

    let server_trust: *const c_void = unsafe { msg_send![&*protection_space, serverTrust] };
    let trusted = !server_trust.is_null()
        && unsafe { SecTrustEvaluateWithError(server_trust, std::ptr::null_mut()) };
    if server_trust.is_null() || trusted {
        unsafe {
            (*completion).call((
                AUTH_CHALLENGE_PERFORM_DEFAULT_HANDLING,
                std::ptr::null_mut(),
            ));
        }
        return;
    }

    let host: Retained<NSString> = unsafe { msg_send![&*protection_space, host] };
    let port: isize = unsafe { msg_send![&*protection_space, port] };
    let host = host.to_string();
    let port = u16::try_from(port).unwrap_or(443);
    let url = if port == 443 {
        format!("https://{host}/")
    } else {
        format!("https://{host}:{port}/")
    };
    let context = webview_contexts()
        .lock()
        .ok()
        .and_then(|contexts| contexts.get(&(webview as usize)).cloned());
    if let Some(context) = context {
        let certificate = EmbeddedBrowserInvalidTlsCertificate {
            native_label: context.native_label.clone(),
            url: url.clone(),
            host,
            port,
        };
        if let Ok(mut certificates) = invalid_tls_certificates().lock() {
            certificates.insert(context.native_label, certificate.clone());
        }
        if let Err(error) = context.app.emit(INVALID_TLS_CERTIFICATE_EVENT, certificate) {
            log::warn!("Failed to emit embedded browser invalid TLS warning: {error}");
        }
    } else {
        log::warn!("Accepted invalid TLS certificate without a registered browser context: {url}");
    }

    let credential_class =
        AnyClass::get(c"NSURLCredential").expect("NSURLCredential must be available on macOS");
    let credential: Retained<AnyObject> =
        unsafe { msg_send![credential_class, credentialForTrust: server_trust] };
    unsafe {
        (*completion).call((
            AUTH_CHALLENGE_USE_CREDENTIAL,
            Retained::as_ptr(&credential).cast_mut(),
        ));
    }
}

unsafe fn install_challenge_handler(delegate: *mut AnyObject) -> Result<(), String> {
    static INSTALL_ONCE: Once = Once::new();
    static INSTALL_ERROR: OnceLock<String> = OnceLock::new();

    INSTALL_ONCE.call_once(|| {
        let class = unsafe { object_getClass(delegate) }.cast_mut();
        if class.is_null() {
            let _ = INSTALL_ERROR.set("Embedded browser navigation delegate has no class".into());
            return;
        }
        let selector = sel!(webView:didReceiveAuthenticationChallenge:completionHandler:);
        if !unsafe { class_getInstanceMethod(class, selector) }.is_null() {
            return;
        }
        let implementation: Imp = unsafe {
            std::mem::transmute::<
                unsafe extern "C-unwind" fn(
                    *mut AnyObject,
                    Sel,
                    *mut AnyObject,
                    *mut AnyObject,
                    *mut AuthenticationChallengeCompletion,
                ),
                Imp,
            >(handle_authentication_challenge)
        };
        let added = unsafe {
            class_addMethod(
                class,
                selector,
                implementation,
                c"v@:@@@?".as_ptr().cast::<c_char>(),
            )
        };
        if !added.as_bool() {
            let _ = INSTALL_ERROR
                .set("Failed to install embedded browser TLS authentication handler".into());
        }
    });

    match INSTALL_ERROR.get() {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

pub async fn register_invalid_tls_handler(
    webview: &Webview<Wry>,
    app: tauri::AppHandle,
    native_label: String,
) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let webview = platform_webview.inner().cast::<AnyObject>();
            let delegate: *mut AnyObject = msg_send![&*webview, navigationDelegate];
            let result = if delegate.is_null() {
                Err("Embedded browser navigation delegate is unavailable".to_string())
            } else {
                install_challenge_handler(delegate).and_then(|_| {
                    webview_contexts()
                        .lock()
                        .map_err(|_| "Embedded browser TLS context lock poisoned".to_string())?
                        .insert(
                            webview as usize,
                            InvalidTlsWebviewContext { app, native_label },
                        );
                    let _: () = msg_send![
                        &*webview,
                        setNavigationDelegate: std::ptr::null::<AnyObject>()
                    ];
                    let _: () = msg_send![&*webview, setNavigationDelegate: delegate];
                    Ok(())
                })
            };
            let _ = sender.try_send(result);
        })
        .map_err(|error| format!("Failed to configure embedded browser TLS handling: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "Embedded browser TLS registration was cancelled".to_string())?
}

pub fn unregister_invalid_tls_handler(webview: &Webview<Wry>) {
    let _ = webview.with_webview(|platform_webview| {
        if let Ok(mut contexts) = webview_contexts().lock() {
            if let Some(context) = contexts.remove(&(platform_webview.inner() as usize)) {
                clear_invalid_tls_certificate(&context.native_label);
            }
        }
    });
}

pub fn invalid_tls_certificate(native_label: &str) -> Option<EmbeddedBrowserInvalidTlsCertificate> {
    invalid_tls_certificates()
        .lock()
        .ok()
        .and_then(|certificates| certificates.get(native_label).cloned())
}

pub fn clear_invalid_tls_certificate(native_label: &str) {
    if let Ok(mut certificates) = invalid_tls_certificates().lock() {
        certificates.remove(native_label);
    }
}

pub fn clear_invalid_tls_certificate_if_origin_changed(native_label: &str, loaded_url: &str) {
    let Some(certificate) = invalid_tls_certificate(native_label) else {
        return;
    };
    let Ok(certificate_url) = tauri::Url::parse(&certificate.url) else {
        clear_invalid_tls_certificate(native_label);
        return;
    };
    let Ok(loaded_url) = tauri::Url::parse(loaded_url) else {
        clear_invalid_tls_certificate(native_label);
        return;
    };
    let same_origin = certificate_url.scheme() == loaded_url.scheme()
        && certificate_url.host_str() == loaded_url.host_str()
        && certificate_url.port_or_known_default() == loaded_url.port_or_known_default();
    if !same_origin {
        clear_invalid_tls_certificate(native_label);
    }
}
