use std::{
    collections::HashMap,
    ffi::{c_void, CStr},
    sync::{Arc, Mutex, OnceLock},
};

use block2::Block;
use objc2::{
    ffi::{objc_getAssociatedObject, objc_setAssociatedObject, OBJC_ASSOCIATION_RETAIN_NONATOMIC},
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
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
struct NavigationDelegateContext {
    app: tauri::AppHandle,
    navigation_generations: Arc<Mutex<HashMap<usize, u64>>>,
}

static WEBVIEW_NATIVE_LABEL_KEY: u8 = 0;

fn webview_contexts() -> &'static Mutex<HashMap<String, NavigationDelegateContext>> {
    static CONTEXTS: OnceLock<Mutex<HashMap<String, NavigationDelegateContext>>> = OnceLock::new();
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
    _delegate: &AnyObject,
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
    let native_label = unsafe { native_label_for_webview(webview) };
    let context = webview_contexts().lock().ok().and_then(|contexts| {
        native_label
            .as_ref()
            .and_then(|label| contexts.get(label).cloned())
    });
    let (Some(native_label), Some(context)) = (native_label, context) else {
        log::warn!("Rejected invalid TLS certificate without a registered browser context: {url}");
        unsafe {
            (*completion).call((
                AUTH_CHALLENGE_PERFORM_DEFAULT_HANDLING,
                std::ptr::null_mut(),
            ));
        }
        return;
    };
    let certificate = EmbeddedBrowserInvalidTlsCertificate {
        native_label: native_label.clone(),
        url,
        host,
        port,
    };
    if let Ok(mut certificates) = invalid_tls_certificates().lock() {
        certificates.insert(native_label, certificate.clone());
    }
    if let Err(error) = context.app.emit(INVALID_TLS_CERTIFICATE_EVENT, certificate) {
        log::warn!("Failed to emit embedded browser invalid TLS warning: {error}");
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

unsafe extern "C-unwind" fn handle_navigation_failure(
    _delegate: &AnyObject,
    _command: Sel,
    webview: *mut AnyObject,
    navigation: *mut AnyObject,
    error: *mut AnyObject,
) {
    if webview.is_null() || error.is_null() {
        return;
    }
    let native_label = unsafe { native_label_for_webview(webview) };
    let context = webview_contexts().lock().ok().and_then(|contexts| {
        native_label
            .as_ref()
            .and_then(|label| contexts.get(label).cloned())
    });
    let (Some(native_label), Some(context)) = (native_label, context) else {
        return;
    };
    let error = unsafe { &*error };
    let code: isize = unsafe { msg_send![error, code] };
    let message: Retained<NSString> = unsafe { msg_send![error, localizedDescription] };
    let navigation_generation = if navigation.is_null() {
        None
    } else {
        context
            .navigation_generations
            .lock()
            .ok()
            .and_then(|mut generations| generations.remove(&(navigation as usize)))
    }
    .or_else(|| {
        crate::embedded_browser::current_navigation_generation(&context.app, &native_label)
    });
    let Some(navigation_generation) = navigation_generation else {
        return;
    };
    let failing_url_key = NSString::from_str("NSErrorFailingURLStringKey");
    let user_info: Retained<AnyObject> = unsafe { msg_send![error, userInfo] };
    let failing_url_value: *mut AnyObject =
        unsafe { msg_send![&*user_info, objectForKey: &*failing_url_key] };
    let failing_url = (!failing_url_value.is_null())
        .then(|| unsafe { &*failing_url_value.cast::<NSString>() }.to_string());
    crate::embedded_browser::handle_navigation_failure(
        &context.app,
        &native_label,
        navigation_generation,
        failing_url,
        code as i64,
        message.to_string(),
    );
}

unsafe extern "C-unwind" fn handle_navigation_started(
    delegate: &AnyObject,
    _command: Sel,
    webview: *mut AnyObject,
    navigation: *mut AnyObject,
) {
    if !webview.is_null() && !navigation.is_null() {
        let native_label = unsafe { native_label_for_webview(webview) };
        let context = webview_contexts().lock().ok().and_then(|contexts| {
            native_label
                .as_ref()
                .and_then(|label| contexts.get(label).cloned())
        });
        if let (Some(native_label), Some(context)) = (native_label, context) {
            if let Some(generation) =
                crate::embedded_browser::current_navigation_generation(&context.app, &native_label)
            {
                if let Ok(mut generations) = context.navigation_generations.lock() {
                    generations.insert(navigation as usize, generation);
                }
            }
        }
    }
    let selector = sel!(webView:didStartProvisionalNavigation:);
    if let Some(superclass) = delegate
        .class()
        .superclass()
        .filter(|class| class.instance_method(selector).is_some())
    {
        let _: () = unsafe {
            msg_send![
                super(delegate, superclass),
                webView: webview,
                didStartProvisionalNavigation: navigation
            ]
        };
    }
}

unsafe extern "C-unwind" fn handle_navigation_redirected(
    delegate: &AnyObject,
    _command: Sel,
    webview: *mut AnyObject,
    navigation: *mut AnyObject,
) {
    if !webview.is_null() && !navigation.is_null() {
        let native_label = unsafe { native_label_for_webview(webview) };
        let context = webview_contexts().lock().ok().and_then(|contexts| {
            native_label
                .as_ref()
                .and_then(|label| contexts.get(label).cloned())
        });
        if let (Some(native_label), Some(context)) = (native_label, context) {
            if let Some(generation) =
                crate::embedded_browser::current_navigation_generation(&context.app, &native_label)
            {
                if let Ok(mut generations) = context.navigation_generations.lock() {
                    generations.insert(navigation as usize, generation);
                }
            }
        }
    }
    let selector = sel!(webView:didReceiveServerRedirectForProvisionalNavigation:);
    if let Some(superclass) = delegate
        .class()
        .superclass()
        .filter(|class| class.instance_method(selector).is_some())
    {
        let _: () = unsafe {
            msg_send![
                super(delegate, superclass),
                webView: webview,
                didReceiveServerRedirectForProvisionalNavigation: navigation
            ]
        };
    }
}

unsafe extern "C-unwind" fn handle_navigation_finished(
    delegate: &AnyObject,
    _command: Sel,
    webview: *mut AnyObject,
    navigation: *mut AnyObject,
) {
    let selector = sel!(webView:didFinishNavigation:);
    if let Some(superclass) = delegate
        .class()
        .superclass()
        .filter(|class| class.instance_method(selector).is_some())
    {
        let _: () = unsafe {
            msg_send![
                super(delegate, superclass),
                webView: webview,
                didFinishNavigation: navigation
            ]
        };
    }
    if webview.is_null() || navigation.is_null() {
        return;
    }
    let native_label = unsafe { native_label_for_webview(webview) };
    let context = webview_contexts().lock().ok().and_then(|contexts| {
        native_label
            .as_ref()
            .and_then(|label| contexts.get(label).cloned())
    });
    if let Some(context) = context {
        if let Ok(mut generations) = context.navigation_generations.lock() {
            generations.remove(&(navigation as usize));
        }
    }
}

fn navigation_delegate_class(superclass: &AnyClass) -> Result<&'static AnyClass, String> {
    static CLASS: OnceLock<Result<&'static AnyClass, String>> = OnceLock::new();
    CLASS
        .get_or_init(|| {
            let challenge_selector =
                sel!(webView:didReceiveAuthenticationChallenge:completionHandler:);
            let fail_selector = sel!(webView:didFailNavigation:withError:);
            let provisional_fail_selector = sel!(webView:didFailProvisionalNavigation:withError:);
            let start_selector = sel!(webView:didStartProvisionalNavigation:);
            let redirect_selector =
                sel!(webView:didReceiveServerRedirectForProvisionalNavigation:);
            let finish_selector = sel!(webView:didFinishNavigation:);
            let has_challenge_handler = superclass.instance_method(challenge_selector).is_some();
            let has_failure_handler = superclass.instance_method(fail_selector).is_some();
            let has_provisional_failure_handler =
                superclass.instance_method(provisional_fail_selector).is_some();
            if has_challenge_handler {
                log::warn!(
                    "Navigation delegate {} already implements TLS authentication handling; preserving it",
                    superclass.name().to_string_lossy()
                );
            }
            if has_failure_handler || has_provisional_failure_handler {
                log::warn!(
                    "Navigation delegate {} already implements navigation failure handling; preserving existing selectors",
                    superclass.name().to_string_lossy()
                );
            }
            let unique_id = std::ptr::addr_of!(WEBVIEW_NATIVE_LABEL_KEY) as usize;
            let class_name = format!("WegentEmbeddedBrowserNavigationDelegate_{unique_id:x}\0");
            let class_name = CStr::from_bytes_with_nul(class_name.as_bytes()).map_err(|error| {
                format!("Invalid embedded browser delegate class name: {error}")
            })?;
            let mut builder = ClassBuilder::new(class_name, superclass).ok_or_else(|| {
                "Failed to allocate embedded browser navigation delegate subclass".to_string()
            })?;
            unsafe {
                if !has_challenge_handler {
                    builder.add_method(
                        challenge_selector,
                        handle_authentication_challenge
                            as unsafe extern "C-unwind" fn(_, _, _, _, _),
                    );
                }
                if !has_failure_handler {
                    builder.add_method(
                        fail_selector,
                        handle_navigation_failure as unsafe extern "C-unwind" fn(_, _, _, _, _),
                    );
                }
                if !has_provisional_failure_handler {
                    builder.add_method(
                        provisional_fail_selector,
                        handle_navigation_failure as unsafe extern "C-unwind" fn(_, _, _, _, _),
                    );
                }
                builder.add_method(
                    start_selector,
                    handle_navigation_started as unsafe extern "C-unwind" fn(_, _, _, _),
                );
                builder.add_method(
                    redirect_selector,
                    handle_navigation_redirected as unsafe extern "C-unwind" fn(_, _, _, _),
                );
                builder.add_method(
                    finish_selector,
                    handle_navigation_finished as unsafe extern "C-unwind" fn(_, _, _, _),
                );
            }
            Ok(builder.register())
        })
        .clone()
}

unsafe fn native_label_for_webview(webview: *mut AnyObject) -> Option<String> {
    if webview.is_null() {
        return None;
    }
    let label = unsafe {
        objc_getAssociatedObject(
            webview,
            std::ptr::addr_of!(WEBVIEW_NATIVE_LABEL_KEY).cast::<c_void>(),
        )
    };
    if label.is_null() {
        return None;
    }
    Some(unsafe { &*label.cast::<NSString>() }.to_string())
}

unsafe fn associate_native_label(webview: *mut AnyObject, native_label: Option<&str>) {
    let label = native_label.map(NSString::from_str);
    let value = label.as_ref().map_or(std::ptr::null_mut(), |label| {
        Retained::as_ptr(label).cast::<AnyObject>().cast_mut()
    });
    unsafe {
        objc_setAssociatedObject(
            webview,
            std::ptr::addr_of!(WEBVIEW_NATIVE_LABEL_KEY).cast::<c_void>(),
            value,
            OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
    }
}

unsafe fn install_navigation_delegate_extensions(delegate: *mut AnyObject) -> Result<(), String> {
    if delegate.is_null() {
        return Err("Embedded browser navigation delegate is unavailable".to_string());
    }
    let delegate = unsafe { &*delegate };
    let current_class = delegate.class();
    let subclass = navigation_delegate_class(current_class)?;
    if !std::ptr::eq(current_class, subclass) {
        let previous_class = unsafe { AnyObject::set_class(delegate, subclass) };
        if !std::ptr::eq(previous_class, current_class) {
            return Err("Embedded browser navigation delegate class changed unexpectedly".into());
        }
    }
    Ok(())
}

unsafe fn restore_navigation_delegate_class(delegate: *mut AnyObject) {
    if delegate.is_null() {
        return;
    }
    let delegate = unsafe { &*delegate };
    let current_class = delegate.class();
    let Some(superclass) = current_class.superclass() else {
        return;
    };
    if current_class
        .name()
        .to_bytes()
        .starts_with(b"WegentEmbeddedBrowserNavigationDelegate_")
    {
        unsafe {
            AnyObject::set_class(delegate, superclass);
        }
    }
}

pub async fn register_navigation_delegate_extensions(
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
                install_navigation_delegate_extensions(delegate).and_then(|_| {
                    associate_native_label(webview, Some(&native_label));
                    webview_contexts()
                        .lock()
                        .map_err(|_| "Embedded browser TLS context lock poisoned".to_string())?
                        .insert(
                            native_label,
                            NavigationDelegateContext {
                                app,
                                navigation_generations: Arc::new(Mutex::new(HashMap::new())),
                            },
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

pub fn unregister_navigation_delegate_extensions(webview: &Webview<Wry>) {
    let _ = webview.with_webview(|platform_webview| unsafe {
        let webview = platform_webview.inner().cast::<AnyObject>();
        if let Some(native_label) = native_label_for_webview(webview) {
            if let Ok(mut contexts) = webview_contexts().lock() {
                contexts.remove(&native_label);
            }
            clear_invalid_tls_certificate(&native_label);
        }
        associate_native_label(webview, None);
        let delegate: *mut AnyObject = msg_send![&*webview, navigationDelegate];
        restore_navigation_delegate_class(delegate);
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
