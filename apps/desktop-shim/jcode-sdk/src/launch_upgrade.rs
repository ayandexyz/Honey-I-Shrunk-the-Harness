//! Best-effort, bounded local upgrade negotiation. Never falls back to Reload.
use super::Progress;
use serde_json::{Value, json};
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_FRAME: usize = 64 * 1024;

pub(super) fn is_local_shared(api: &Path, native: &Path, candidate: &Path) -> bool {
        todo!("jcode-sdk shim: is_local_shared")
    }

fn connect(path: &Path, timeout: Duration) -> io::Result<UnixStream> {
        todo!("jcode-sdk shim: connect")
    }

fn read_frame(stream: &mut UnixStream, deadline: Instant) -> io::Result<Option<Value>> {
        todo!("jcode-sdk shim: read_frame")
    }

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Unchanged,
    Busy(String),
    Deferred(String),
    ReconnectPending,
}

fn request(socket: &Path, candidate: &Path, timeout: Duration) -> io::Result<Outcome> {
        todo!("jcode-sdk shim: request")
    }

pub(super) fn offer(
    socket: &Path,
    candidate: &Path,
    startup_timeout: Duration,
    progress: &Progress<'_>,
) {
        todo!("jcode-sdk shim: offer")
    }

fn confirm_reconnect(socket: &Path, candidate: &Path, timeout: Duration) -> io::Result<()> {
        todo!("jcode-sdk shim: confirm_reconnect")
    }

fn retry_until_idle(
    socket: &Path,
    candidate: &Path,
    attempts: usize,
    delay: Duration,
) -> io::Result<Outcome> {
        todo!("jcode-sdk shim: retry_until_idle")
    }

fn schedule_retry(socket: &Path, candidate: &Path) {
        todo!("jcode-sdk shim: schedule_retry")
    }

#[cfg(test)]
#[path = "launch_upgrade_tests.rs"]
mod tests;
