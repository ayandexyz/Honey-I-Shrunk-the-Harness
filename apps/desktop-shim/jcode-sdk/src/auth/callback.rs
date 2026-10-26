//! Bounded local OAuth redirect receiver. No credential or URL is logged.
use super::*;
use std::net::{Ipv4Addr, TcpListener, TcpStream};

pub(super) struct CallbackListener {
    listener: Mutex<Option<TcpListener>>,
    redirect: url::Url,
    state: String,
}

impl CallbackListener {
    pub(super) fn bind(auth_url: &url::Url) -> Option<Self> {
        todo!("jcode-sdk shim: bind")
    }

    pub(super) fn close(&self) {
        todo!("jcode-sdk shim: close")
    }

    fn interrupted(flow: &FlowInner) -> bool {
        todo!("jcode-sdk shim: interrupted")
    }

    pub(super) fn wait(&self, flow: &FlowInner) -> Result<String> {
        todo!("jcode-sdk shim: wait")
    }

    fn receive(
        &self,
        stream: &mut TcpStream,
        flow: &FlowInner,
        deadline: Instant,
    ) -> Option<String> {
        todo!("jcode-sdk shim: receive")
    }

    fn parse_request(&self, request: &[u8]) -> Option<String> {
        todo!("jcode-sdk shim: parse_request")
    }
}
