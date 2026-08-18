use std::{cell::Cell, rc::Rc, time::Duration};

use gtk::prelude::*;
use tauri::{LogicalPosition, LogicalSize, Webview, Wry};

const HOST_NAME: &str = "wework-embedded-browser-host";
const ALLOCATION_CONTROLLER_DATA: &str = "wework-embedded-browser-allocation-controller";

#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct AllocationTarget {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

struct AllocationController {
    target: Cell<AllocationTarget>,
    applying: Cell<bool>,
}

fn find_host(container: &gtk::Box) -> Option<gtk::Fixed> {
    container.children().into_iter().find_map(|child| {
        let overlay = child.downcast::<gtk::Overlay>().ok()?;
        overlay.children().into_iter().find_map(|overlay_child| {
            if overlay_child.widget_name() != HOST_NAME {
                return None;
            }
            overlay_child.downcast::<gtk::Fixed>().ok()
        })
    })
}

fn create_host(
    container: &gtk::Box,
    embedded_webview: &webkit2gtk::WebView,
) -> Result<gtk::Fixed, String> {
    let embedded_widget = embedded_webview.clone().upcast::<gtk::Widget>();
    let (main_webview_index, main_webview) = container
        .children()
        .into_iter()
        .enumerate()
        .find_map(|(index, child)| {
            if child == embedded_widget {
                return None;
            }
            child
                .downcast::<webkit2gtk::WebView>()
                .ok()
                .map(|webview| (index, webview))
        })
        .ok_or_else(|| "Main webview was not found in the GTK window container".to_string())?;

    container.remove(&main_webview);

    let overlay = gtk::Overlay::new();
    overlay.set_hexpand(true);
    overlay.set_vexpand(true);
    overlay.add(&main_webview);

    let host = gtk::Fixed::new();
    host.set_widget_name(HOST_NAME);
    host.set_hexpand(true);
    host.set_vexpand(true);
    host.set_halign(gtk::Align::Fill);
    host.set_valign(gtk::Align::Fill);
    overlay.add_overlay(&host);

    container.pack_start(&overlay, true, true, 0);
    container.reorder_child(&overlay, main_webview_index as i32);
    main_webview.show();
    host.show();
    overlay.show();

    Ok(host)
}

fn place_webview(
    embedded_webview: webkit2gtk::WebView,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<(), String> {
    let host = match embedded_webview
        .parent()
        .and_then(|parent| parent.downcast::<gtk::Fixed>().ok())
    {
        Some(host) => host,
        None => {
            let container = embedded_webview
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Box>().ok())
                .ok_or_else(|| {
                    "Embedded browser webview is not attached to the GTK window container"
                        .to_string()
                })?;
            let host = find_host(&container)
                .map(Ok)
                .unwrap_or_else(|| create_host(&container, &embedded_webview))?;
            container.remove(&embedded_webview);
            host.put(&embedded_webview, 0, 0);
            host
        }
    };

    // The Tauri-created WebView expands by default. In a GtkFixed host that
    // makes the page viewport match the full host width instead of the bounds
    // requested by the device toolbar.
    embedded_webview.set_hexpand(false);
    embedded_webview.set_vexpand(false);
    embedded_webview.set_halign(gtk::Align::Start);
    embedded_webview.set_valign(gtk::Align::Start);
    let x = position.x.round() as i32;
    let y = position.y.round() as i32;
    let width = size.width.round() as i32;
    let height = size.height.round() as i32;
    embedded_webview.set_size_request(width, height);
    host.move_(&embedded_webview, x, y);
    let controller = allocation_controller(&embedded_webview);
    controller.target.set(AllocationTarget {
        x,
        y,
        width,
        height,
    });
    apply_webview_allocation(&embedded_webview, x, y, width, height);

    Ok(())
}

fn allocation_controller(webview: &webkit2gtk::WebView) -> Rc<AllocationController> {
    if let Some(controller) =
        unsafe { webview.data::<Rc<AllocationController>>(ALLOCATION_CONTROLLER_DATA) }
            .map(|data| unsafe { data.as_ref().clone() })
    {
        return controller;
    }

    let controller = Rc::new(AllocationController {
        target: Cell::new(AllocationTarget::default()),
        applying: Cell::new(false),
    });
    let callback_controller = controller.clone();
    webview.connect_size_allocate(move |webview, allocation| {
        let target = callback_controller.target.get();
        if callback_controller.applying.get()
            || (allocation.x() == target.x
                && allocation.y() == target.y
                && allocation.width() == target.width
                && allocation.height() == target.height)
        {
            return;
        }

        callback_controller.applying.set(true);
        if let Some(host) = webview
            .parent()
            .and_then(|parent| parent.downcast::<gtk::Fixed>().ok())
        {
            host.move_(webview, target.x, target.y);
        }
        apply_webview_allocation(webview, target.x, target.y, target.width, target.height);
        callback_controller.applying.set(false);
    });
    unsafe { webview.set_data(ALLOCATION_CONTROLLER_DATA, controller.clone()) };
    controller
}

fn apply_webview_allocation(
    embedded_webview: &webkit2gtk::WebView,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) {
    // GtkFixed normally allocates a child from its natural size. Apply the
    // requested allocation explicitly so WebKit reports the device viewport
    // instead of the host's full width through window.innerWidth.
    let allocation = gtk::Allocation::new(x, y, width, height);
    embedded_webview.set_allocation(&allocation);
    embedded_webview.size_allocate(&allocation);
}

pub fn apply_bounds(
    webview: &Webview<Wry>,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<(), String> {
    // Tauri packs Linux child webviews into the main GtkBox, so their requested
    // overlay bounds are ignored and they can collapse the app webview. Move
    // them into an absolute overlay host before exposing them to the frontend.
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let _ = sender.send(place_webview(platform_webview.inner(), position, size));
        })
        .map_err(|error| format!("Failed to access embedded browser webview: {error}"))?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Timed out positioning embedded browser webview: {error}"))?
}
