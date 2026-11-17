use std::{
    fs,
    io::{self, Write},
    path::Path,
};

/// Keep bootstrap transactions separate from Electron's application singleton.
pub fn serve(path: &Path) -> io::Result<()> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    file.lock()?;
    let mut output = io::stdout().lock();
    writeln!(output, "locked")?;
    output.flush()?;
    // EOF also releases ownership when the Electron parent crashes.
    io::copy(&mut io::stdin().lock(), &mut io::sink())?;
    Ok(())
}
