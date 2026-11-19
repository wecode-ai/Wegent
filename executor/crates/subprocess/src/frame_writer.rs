//! Retain complete protocol frames and their offsets when an awaiting write is cancelled.
use std::{collections::VecDeque, io};

use tokio::io::{AsyncWrite, AsyncWriteExt};

pub struct FrameWriter<W> {
    writer: W,
    pending: VecDeque<Vec<u8>>,
    offset: usize,
}

impl<W: AsyncWrite + Unpin> FrameWriter<W> {
    pub fn new(writer: W) -> Self {
        Self {
            writer,
            pending: VecDeque::new(),
            offset: 0,
        }
    }

    pub async fn write_frame(&mut self, frame: Vec<u8>) -> io::Result<()> {
        self.pending.push_back(frame);
        self.flush().await
    }

    pub async fn flush(&mut self) -> io::Result<()> {
        while let Some(frame) = self.pending.front() {
            while self.offset < frame.len() {
                let written = self.writer.write(&frame[self.offset..]).await?;
                if written == 0 {
                    return Err(io::ErrorKind::WriteZero.into());
                }
                self.offset += written;
            }
            self.pending.pop_front();
            self.offset = 0;
        }
        self.writer.flush().await
    }

    /// Transfer the writer only after the protocol handshake has finished flushing.
    pub fn into_inner(self) -> W {
        self.writer
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
    };
    use tokio::io::AsyncReadExt;

    #[test]
    fn cancellation_preserves_split_utf8_and_frame_order() {
        let (writer, mut reader) = tokio::io::duplex(1);
        let mut writer = FrameWriter::new(writer);
        let mut context = Context::from_waker(Waker::noop());
        let first = "{\"id\":1,\"text\":\"等\"}\n".as_bytes().to_vec();
        let second = b"{\"id\":2}\n".to_vec();
        let expected = [first.clone(), second.clone()].concat();
        let mut output = Vec::new();
        let mut writing = Box::pin(writer.write_frame(first));
        // Interrupt after two bytes of the multibyte character were written.
        for _ in 0..18 {
            assert!(writing.as_mut().poll(&mut context).is_pending());
            let mut byte = [0];
            assert!(pin!(reader.read_exact(&mut byte))
                .poll(&mut context)
                .is_ready());
            output.push(byte[0]);
        }
        drop(writing);
        let mut writing = Box::pin(writer.write_frame(second));
        loop {
            let done = matches!(writing.as_mut().poll(&mut context), Poll::Ready(Ok(())));
            let mut byte = [0];
            match pin!(reader.read(&mut byte)).poll(&mut context) {
                Poll::Ready(Ok(1)) => output.push(byte[0]),
                Poll::Pending if done => {}
                result => panic!("unexpected read: {result:?}"),
            }
            if done {
                break;
            }
        }
        assert_eq!(output, expected);
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "{\"id\":1,\"text\":\"等\"}\n{\"id\":2}\n"
        );
    }
}
