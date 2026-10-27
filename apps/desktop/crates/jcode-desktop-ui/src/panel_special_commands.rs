//! Specialist slash commands. Runtime state always belongs to the selected session.
use super::*;
use jcode_sdk::api::RuntimeCommand;

#[derive(Debug, PartialEq)]
enum SpecialCommand {
    Runtime(RuntimeCommand, Vec<String>),
    Support,
    Subscribe,
    SwarmPrompt,
    Dictation,
    Usage(&'static str),
}

/// `/night` is spelled that way to match freecode's TUI (`apps/tui/src/commands/
/// built-in.ts`'s `/night`); it still tags the wire as `RuntimeCommand::Overnight`
/// because that enum lives in the external `jcode_harness_api` crate, which
/// this repo does not own. `/initiatives`, `/goals`, `/productivity`,
/// `/wrapped` and the premium `/z` tier are jcode-only with no freecode
/// equivalent and are gone, not just renamed.
fn parse_special_command(content: &str) -> Option<SpecialCommand> {
    use SpecialCommand::*;
    let mut words = content.split_whitespace();
    let name = words.next()?;
    let args: Vec<String> = words.map(str::to_owned).collect();
    let exact = |command, usage| {
        if args.is_empty() {
            command
        } else {
            Usage(usage)
        }
    };
    Some(match name {
        "/night" => Runtime(RuntimeCommand::Overnight, args),
        "/support" => exact(
            Support,
            "Usage: `/support`. Opens a diagnostic email draft, never sends it.",
        ),
        "/subscribe" => exact(
            Subscribe,
            "Usage: `/subscribe`. Opens the native account dialog.",
        ),
        "/swarm-prompt" => exact(SwarmPrompt, "Usage: `/swarm-prompt`."),
        "/dictate" | "/dictation" => exact(Dictation, "Usage: `/dictate` or `/dictation`."),
        _ => return None,
    })
}

fn percent_encode(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            result.push(char::from(byte));
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

fn support_draft(provider: &str, model: &str) -> (String, String) {
    // Deliberately excludes transcripts, credentials, account identity and file paths.
    let body = format!(
        "Describe your issue:\n\n\n--- Desktop diagnostics ---\nVersion: {}\nBuild: {}\nOS/Arch: {}/{}\nProvider: {}\nModel: {}\n\nPlease review this draft before sending. No conversation text or credentials were included.\n",
        env!("JCODE_DESKTOP_VERSION"),
        env!("JCODE_DESKTOP_BUILD_ID"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        provider,
        model
    );
    let url = format!(
        "mailto:support@jcode.sh?subject=jcode%20Desktop%20support&body={}",
        percent_encode(&body)
    );
    (body, url)
}

/// Materialize the selected prompt only when the user explicitly requests editing.
fn editable_swarm_prompt(working_dir: Option<&str>) -> anyhow::Result<std::path::PathBuf> {
    let global = jcode_base::storage::jcode_dir()?.join("swarm-prompt.md");
    let project = working_dir.map(|dir| std::path::Path::new(dir).join(".jcode/swarm-prompt.md"));
    let path = project
        .filter(|path| std::fs::read_to_string(path).is_ok_and(|text| !text.trim().is_empty()))
        .unwrap_or(global);
    if !path.exists() {
        std::fs::create_dir_all(
            path.parent()
                .ok_or_else(|| anyhow::anyhow!("Prompt has no parent directory"))?,
        )?;
        // Never overwrite a prompt another worker/editor created concurrently.
        use std::io::Write;
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => file.write_all(jcode_base::prompt::DEFAULT_SWARM_PROMPT.as_bytes())?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(path)
}

impl Panel {
    pub(super) fn handle_special_command(&mut self, content: &str, cx: &mut Context<Self>) -> bool {
        let Some(command) = parse_special_command(content) else {
            return false;
        };
        if self.is_side_document() || self.preview_state.is_some() {
            self.items.push(Item::Error(
                "Special commands require a regular Desktop session.".into(),
            ));
            cx.notify();
            return true;
        }
        match command {
            SpecialCommand::Runtime(command, args) => self.bridge.send(Command::RuntimeCommand {
                session_id: self.session_id.clone(),
                command,
                args,
            }),
            SpecialCommand::Usage(usage) => self.items.push(Item::Error(usage.into())),
            SpecialCommand::Support => {
                let (body, url) = support_draft(
                    self.provider.as_deref().unwrap_or("unknown"),
                    self.model.as_deref().unwrap_or("unknown"),
                );
                cx.open_url(&url);
                self.items.push(Item::Assistant(format!("Opened a support email draft for `support@jcode.sh`. Nothing was sent. If your mail app did not open, copy this draft:\n\n{body}")));
            }
            SpecialCommand::Subscribe => {
                // Composer dispatches OpenAccounts before pending-session handling.
                // Direct callers still get useful subscription information, never a charge.
                self.items.push(Item::Assistant("Subscribe through the native Accounts dialog: choose Honey, review the plan, then explicitly confirm checkout. `/account` opens that dialog. No checkout or payment was started.".into()));
            }
            SpecialCommand::SwarmPrompt => {
                if crate::harness::remote_host(&self.session_id).is_some() {
                    self.items.push(Item::Error("The active swarm prompt belongs to the remote runtime. Edit `.jcode/swarm-prompt.md` in that remote checkout or `~/.jcode/swarm-prompt.md` on that host. Desktop will not open or change a local file on its behalf.".into()));
                } else {
                    let directory = self.working_dir.clone();
                    let task = cx
                        .background_executor()
                        .spawn(async move { editable_swarm_prompt(directory.as_deref()) });
                    cx.spawn(async move |this, cx| {
                        let result = task.await;
                        let _ = this.update(cx, |panel, cx| {
                            match result {
                                Ok(path) => {
                                    cx.open_url(&format!("file://{}", percent_encode(&path.to_string_lossy())));
                                    panel.items.push(Item::Assistant(format!("Opened the active swarm prompt: `{}`. Changes apply when new agents load their routing prompt.", path.display())));
                                }
                                Err(error) => panel.items.push(Item::Error(format!("Could not open swarm prompt: {error:#}"))),
                            }
                            cx.notify();
                        });
                    }).detach();
                }
            }
            SpecialCommand::Dictation => {
                let task = cx.background_executor().spawn(async {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?
                        .block_on(jcode_voice::dictation::run_configured())
                });
                self.items.push(Item::Assistant("Running the configured local dictation command. The transcript will be inserted into this composer's draft for review, not submitted automatically.".into()));
                cx.spawn(async move |this, cx| {
                    let result: anyhow::Result<jcode_voice::dictation::DictationRun> = task.await;
                    let _ = this.update(cx, |panel, cx| {
                        match result {
                            Ok(run) => panel
                                .input
                                .update(cx, |input, cx| input.append_dictation(&run.text, cx)),
                            Err(error) => panel
                                .items
                                .push(Item::Error(format!("Dictation failed: {error:#}"))),
                        }
                        cx.notify();
                    });
                })
                .detach();
            }
        }
        self.stick_to_bottom = true;
        cx.notify();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[gpui::test]
    fn specialist_runtime_commands_use_the_source_connection_not_prompt_send(
        cx: &mut gpui::TestAppContext,
    ) {
        let (bridge, commands) = crate::harness::spawn_recording();
        let panel = cx.new(|cx| Panel::new("special-source".into(), None, None, bridge, cx));
        panel.update(cx, |panel, cx| {
            assert!(panel.handle_special_command("/night status", cx));
            assert!(panel.handle_special_command("/support unexpected", cx));
            assert!(matches!(panel.items.last(), Some(Item::Error(_))));
        });
        let captured: Vec<_> = commands.try_iter().collect();
        assert_eq!(captured.len(), 1);
        for command in captured {
            assert!(
                matches!(command, Command::RuntimeCommand { session_id, .. } if session_id == "special-source")
            );
        }
    }

    #[test]
    fn aliases_and_exact_names() {
        assert_eq!(
            parse_special_command("/dictation"),
            parse_special_command("/dictate")
        );
        for value in [
            "/overnight",
            "/overnightly",
            "/initiatives",
            "/goals",
            "/productivity",
            "/wrapped",
            "/z",
            "/zz",
            "/zzz",
            "/zstatus",
            "/zebra",
            "/supported",
            "/subscribe-now",
            "dictate",
            "",
        ] {
            assert_eq!(parse_special_command(value), None, "{value}");
        }
        assert!(matches!(
            parse_special_command("/support extra"),
            Some(SpecialCommand::Usage(_))
        ));
    }
    #[test]
    fn night_preserves_arguments() {
        assert_eq!(
            parse_special_command(" /night 8h fix tests "),
            Some(SpecialCommand::Runtime(
                RuntimeCommand::Overnight,
                vec!["8h".into(), "fix".into(), "tests".into()]
            ))
        );
    }
    #[test]
    fn mailto_encoding_does_not_allow_header_injection() {
        let (body, url) = support_draft("provider&bcc=bad", "model\r\nBcc: bad");
        assert!(body.contains("Version:"));
        assert!(!url.contains("&bcc="));
        assert!(!url.contains('\n'));
        assert!(url.contains("%26bcc%3Dbad"));
        assert_eq!(percent_encode("a b?#%"), "a%20b%3F%23%25");
    }
}
