use futures_util::future::BoxFuture;
use std::{
    fmt::Debug,
    ops::{Deref, DerefMut},
};

use crate::{Event, Payload};

use super::client::{Client, ReconnectSettings};

/// Internal type, provides a way to store futures and return them in a boxed manner.
///
/// Event callbacks are `Fn` (not `FnMut`): since issue #12 each packet is
/// dispatched as an independent task, so the same callback may be invoked
/// concurrently from several tasks through a shared reference.
pub(crate) type DynAsyncCallback =
    Box<dyn Fn(Payload, Client) -> BoxFuture<'static, ()> + 'static + Send + Sync>;

pub(crate) type DynAsyncAnyCallback =
    Box<dyn Fn(Event, Payload, Client) -> BoxFuture<'static, ()> + 'static + Send + Sync>;

/// Close callback with the session epoch captured when the close dispatch was
/// spawned (the still-dying session's generation, see issue #15).
pub(crate) type DynAsyncCloseCallback =
    Box<dyn Fn(Payload, u64, Client) -> BoxFuture<'static, ()> + 'static + Send + Sync>;

pub(crate) type DynAsyncReconnectSettingsCallback =
    Box<dyn FnMut() -> BoxFuture<'static, ReconnectSettings> + 'static + Send + Sync>;

pub(crate) struct Callback<T> {
    inner: T,
}

impl<T> Debug for Callback<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Callback")
    }
}

impl Deref for Callback<DynAsyncCallback> {
    type Target = dyn Fn(Payload, Client) -> BoxFuture<'static, ()> + 'static + Sync + Send;

    fn deref(&self) -> &Self::Target {
        self.inner.as_ref()
    }
}

impl Callback<DynAsyncCallback> {
    pub(crate) fn new<T>(callback: T) -> Self
    where
        T: Fn(Payload, Client) -> BoxFuture<'static, ()> + 'static + Sync + Send,
    {
        Callback {
            inner: Box::new(callback),
        }
    }
}

impl Deref for Callback<DynAsyncAnyCallback> {
    type Target = dyn Fn(Event, Payload, Client) -> BoxFuture<'static, ()> + 'static + Sync + Send;

    fn deref(&self) -> &Self::Target {
        self.inner.as_ref()
    }
}

impl Callback<DynAsyncAnyCallback> {
    pub(crate) fn new<T>(callback: T) -> Self
    where
        T: Fn(Event, Payload, Client) -> BoxFuture<'static, ()> + 'static + Sync + Send,
    {
        Callback {
            inner: Box::new(callback),
        }
    }
}

impl Deref for Callback<DynAsyncCloseCallback> {
    type Target = dyn Fn(Payload, u64, Client) -> BoxFuture<'static, ()> + 'static + Sync + Send;

    fn deref(&self) -> &Self::Target {
        self.inner.as_ref()
    }
}

impl Callback<DynAsyncCloseCallback> {
    pub(crate) fn new<T>(callback: T) -> Self
    where
        T: Fn(Payload, u64, Client) -> BoxFuture<'static, ()> + 'static + Sync + Send,
    {
        Callback {
            inner: Box::new(callback),
        }
    }
}

impl Deref for Callback<DynAsyncReconnectSettingsCallback> {
    type Target = dyn FnMut() -> BoxFuture<'static, ReconnectSettings> + 'static + Sync + Send;

    fn deref(&self) -> &Self::Target {
        self.inner.as_ref()
    }
}

impl DerefMut for Callback<DynAsyncReconnectSettingsCallback> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.inner.as_mut()
    }
}

impl Callback<DynAsyncReconnectSettingsCallback> {
    pub(crate) fn new<T>(callback: T) -> Self
    where
        T: FnMut() -> BoxFuture<'static, ReconnectSettings> + 'static + Sync + Send,
    {
        Callback {
            inner: Box::new(callback),
        }
    }
}
