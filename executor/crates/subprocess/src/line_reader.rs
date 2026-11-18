//! Preserve partial subprocess output when an awaiting protocol read is cancelled.
use std::io;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub struct LineReader<R> {
    reader: R,
    pending: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> LineReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            pending: Vec::new(),
        }
    }

    /// Like `read_line`, retaining partial UTF-8 and newline bytes across cancellation.
    pub async fn read_line(&mut self, output: &mut String) -> io::Result<usize> {
        self.reader.read_until(b'\n', &mut self.pending).await?;
        let text = std::str::from_utf8(&self.pending)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        output.push_str(text);
        let count = self.pending.len();
        self.pending.clear();
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    use tokio::io::{AsyncWriteExt, BufReader};

    #[test]
    fn cancelled_reads_preserve_partial_json_and_split_utf8() {
        let mut context = Context::from_waker(Waker::noop());
        let (input, mut output) = tokio::io::duplex(128);
        let mut reader = LineReader::new(BufReader::new(input));
        let mut line = String::new();
        let prefix = b"{\"goal\":\"\xe7";
        assert!(matches!(
            Box::pin(output.write_all(prefix))
                .as_mut()
                .poll(&mut context),
            Poll::Ready(Ok(()))
        ));
        let mut interrupted = Box::pin(reader.read_line(&mut line));
        assert!(interrupted.as_mut().poll(&mut context).is_pending());
        drop(interrupted);
        assert!(line.is_empty());
        let suffix = b"\xad\x89\"}\n";
        assert!(matches!(
            Box::pin(output.write_all(suffix))
                .as_mut()
                .poll(&mut context),
            Poll::Ready(Ok(()))
        ));
        assert!(
            matches!(Box::pin(reader.read_line(&mut line)).as_mut().poll(&mut context), Poll::Ready(Ok(count)) if count == prefix.len() + suffix.len())
        );
        assert_eq!(line, "{\"goal\":\"等\"}\n");
    }

    #[test]
    fn eof_preserves_unterminated_output_and_appends_to_the_callers_buffer() {
        let mut reader = LineReader::new(std::io::Cursor::new(b"last line"));
        let mut context = Context::from_waker(Waker::noop());
        let mut line = String::from("prefix:");
        assert!(matches!(
            Box::pin(reader.read_line(&mut line))
                .as_mut()
                .poll(&mut context),
            Poll::Ready(Ok(9))
        ));
        assert_eq!(line, "prefix:last line");
        assert!(matches!(
            Box::pin(reader.read_line(&mut line))
                .as_mut()
                .poll(&mut context),
            Poll::Ready(Ok(0))
        ));
    }
}
