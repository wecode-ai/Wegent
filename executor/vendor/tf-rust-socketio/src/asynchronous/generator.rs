use std::{
    collections::HashMap,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
    task::{Poll, Waker},
};

use crate::error::Result;
use futures_util::{ready, FutureExt, Stream, StreamExt};
use tokio::sync::Mutex;

/// A handy type alias for a pinned + boxed Stream trait object that iterates
/// over object of a certain type `T`.
pub(crate) type Generator<T> = Pin<Box<dyn Stream<Item = T> + 'static + Send>>;

/// An internal type that implements stream by repeatedly calling [`Stream::poll_next`] on an
/// underlying stream. Note that the generic parameter will be wrapped in a [`Result`].
pub(crate) struct StreamGenerator<T> {
    inner: Arc<Mutex<Generator<Result<T>>>>,
    readers: Arc<StdMutex<PendingReaders>>,
    // Each clone needs its own identity, even when readers share a task waker.
    reader: Arc<()>,
}

#[derive(Default)]
struct PendingReaders {
    cleared: bool,
    wakers: HashMap<usize, Waker>,
}

impl<T: Clone> Clone for StreamGenerator<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            readers: self.readers.clone(),
            reader: Arc::new(()),
        }
    }
}

impl<T> Drop for StreamGenerator<T> {
    fn drop(&mut self) {
        let waker = self
            .readers
            .lock()
            .unwrap()
            .wakers
            .remove(&self.reader_id());
        drop(waker);
    }
}

impl<T> Stream for StreamGenerator<T> {
    type Item = Result<T>;

    fn poll_next(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let waker = cx.waker().clone();
        let previous_waker = {
            let mut readers = self.readers.lock().unwrap();
            if readers.cleared {
                return Poll::Ready(None);
            }
            // Register before acquiring the stream lock, which can also return Pending.
            readers.wakers.insert(self.reader_id(), waker)
        };
        drop(previous_waker);

        let mut lock = ready!(Box::pin(self.inner.lock()).poll_unpin(cx));
        let result = lock.poll_next_unpin(cx);
        drop(lock);
        if result.is_ready() {
            let waker = self
                .readers
                .lock()
                .unwrap()
                .wakers
                .remove(&self.reader_id());
            drop(waker);
        }
        result
    }
}

impl<T> StreamGenerator<T> {
    /// Release the stream's captured transport even while socket handles live.
    pub(crate) async fn clear(&self)
    where
        T: Send + 'static,
    {
        let mut stream = self.inner.lock().await;
        let previous_stream =
            std::mem::replace(&mut *stream, Box::pin(futures_util::stream::empty()));
        let wakers = {
            let mut readers = self.readers.lock().unwrap();
            // Later polls must see EOF even before the stream lock is released.
            readers.cleared = true;
            std::mem::take(&mut readers.wakers)
        };
        drop(stream);
        // Dropping the captured stream can also invoke waker callbacks.
        drop(previous_stream);
        for waker in wakers.into_values() {
            waker.wake();
        }
    }

    pub(crate) fn new(generator_stream: Generator<Result<T>>) -> Self {
        StreamGenerator {
            inner: Arc::new(Mutex::new(generator_stream)),
            readers: Arc::new(StdMutex::new(PendingReaders::default())),
            reader: Arc::new(()),
        }
    }

    fn reader_id(&self) -> usize {
        Arc::as_ptr(&self.reader) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Weak,
        },
        task::{Context, Poll, Wake, Waker},
    };

    struct ReaderWake {
        inner: Weak<Mutex<Generator<Result<u8>>>>,
        wakes: AtomicUsize,
    }

    impl Wake for ReaderWake {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }

        fn wake_by_ref(self: &Arc<Self>) {
            let inner = self.inner.upgrade().unwrap();
            assert!(
                inner.try_lock().is_ok(),
                "clear must release the stream lock before waking readers"
            );
            self.wakes.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn reader_wake(generator: &StreamGenerator<u8>) -> Arc<ReaderWake> {
        Arc::new(ReaderWake {
            inner: Arc::downgrade(&generator.inner),
            wakes: AtomicUsize::new(0),
        })
    }

    #[tokio::test]
    async fn clear_wakes_every_pending_reader_with_its_latest_waker() {
        let generator = StreamGenerator::new(Box::pin(futures_util::stream::pending()));
        let mut first = generator.clone();
        let mut second = generator.clone();
        let old_wake = reader_wake(&generator);
        let first_wake = reader_wake(&generator);
        let second_wake = reader_wake(&generator);
        let old_waker = Waker::from(old_wake.clone());
        let first_waker = Waker::from(first_wake.clone());
        let second_waker = Waker::from(second_wake.clone());
        let mut old_context = Context::from_waker(&old_waker);
        let mut first_context = Context::from_waker(&first_waker);
        let mut second_context = Context::from_waker(&second_waker);
        let mut first_next = Box::pin(first.next());
        let mut second_next = Box::pin(second.next());

        assert!(first_next.poll_unpin(&mut old_context).is_pending());
        assert!(first_next.poll_unpin(&mut first_context).is_pending());
        assert!(second_next.poll_unpin(&mut second_context).is_pending());

        generator.clear().await;

        assert_eq!(old_wake.wakes.load(Ordering::SeqCst), 0);
        assert_eq!(first_wake.wakes.load(Ordering::SeqCst), 1);
        assert_eq!(second_wake.wakes.load(Ordering::SeqCst), 1);
        assert!(matches!(
            first_next.poll_unpin(&mut first_context),
            Poll::Ready(None)
        ));
        assert!(matches!(
            second_next.poll_unpin(&mut second_context),
            Poll::Ready(None)
        ));

        let mut late_reader = generator.clone();
        assert!(matches!(
            late_reader.next().poll_unpin(&mut first_context),
            Poll::Ready(None)
        ));
        generator.clear().await;
        assert_eq!(first_wake.wakes.load(Ordering::SeqCst), 1);
        assert_eq!(second_wake.wakes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn clear_wakes_reader_pending_on_the_stream_lock() {
        let generator = StreamGenerator::new(Box::pin(futures_util::stream::pending()));
        let mut reader = generator.clone();
        let wake = reader_wake(&generator);
        let waker = Waker::from(wake.clone());
        let mut context = Context::from_waker(&waker);
        let mut next = Box::pin(reader.next());
        let stream_lock = generator.inner.lock().await;

        assert!(next.poll_unpin(&mut context).is_pending());
        drop(stream_lock);
        let wakes_before_clear = wake.wakes.load(Ordering::SeqCst);

        generator.clear().await;

        assert!(wake.wakes.load(Ordering::SeqCst) > wakes_before_clear);
        assert!(matches!(next.poll_unpin(&mut context), Poll::Ready(None)));
    }
}
