//! `@` file mentions in the prompt composer.
//!
//! Typing `@` opens a picker of files under the project's working directory;
//! picking one inserts `@path/to/file` into the prompt. The path is what the
//! agent reads with its own file tools, so nothing is uploaded and no binary
//! file is inlined.
//!
//! The logic lives here, GPUI-free, so it can be tested without a window: the
//! composer only renders rows and inserts text.

use std::path::{Path, PathBuf};

/// Directories skipped while walking, mirroring the TUI's file search.
/// These hold build output and dependency trees, never mention targets.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".cache",
    "target",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
];

/// Walk budget. Breadth-first, so hitting it drops the deepest paths first.
const MAX_ENTRIES: usize = 20_000;

/// Characters that end a path token, so `@` in the middle of a word is not a
/// mention and `foo@bar` is not a mention either.
const PATH_DELIMITERS: [char; 6] = [' ', '\t', '\n', '"', '\'', '='];

/// A file or directory under the working directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEntry {
    /// Path relative to the working directory, always `/`-separated.
    pub path: String,
    pub is_directory: bool,
}

/// One row of the picker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MentionCandidate {
    /// The text inserted into the prompt, e.g. `@src/main.rs`.
    pub value: String,
    /// The file's own name, for the row's main label.
    pub label: String,
    /// The full relative path, for the row's secondary label.
    pub detail: String,
}

/// The `@…` token under the cursor, or `None` when the cursor is not in one.
///
/// The returned token includes the leading `@` and any quote that opened it.
pub fn mention_prefix(text: &str) -> Option<&str> {
    // A quoted path keeps its spaces: `@"my file.rs"`.
    if let Some(quote_start) = unclosed_quote_start(text) {
        if quote_start > 0
            && text.as_bytes()[quote_start - 1] == b'@'
            && is_token_start(text, quote_start - 1)
        {
            return Some(&text[quote_start - 1..]);
        }
        return None;
    }

    let bytes = text.as_bytes();
    let mut token_start = 0;
    for index in (0..bytes.len()).rev() {
        if PATH_DELIMITERS.contains(&(bytes[index] as char)) {
            token_start = index + 1;
            break;
        }
    }
    if bytes.get(token_start) == Some(&b'@') {
        Some(&text[token_start..])
    } else {
        None
    }
}

/// Start of an unterminated `"…` run, so quoted paths keep their spaces.
fn unclosed_quote_start(text: &str) -> Option<usize> {
    let mut in_quotes = false;
    let mut quote_start = 0;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'"' {
            in_quotes = !in_quotes;
            if in_quotes {
                quote_start = index;
            }
        }
    }
    if in_quotes {
        Some(quote_start)
    } else {
        None
    }
}

/// A mention starts at a word boundary, so an email address or a decorator
/// (`@Component`) is not read as a path.
fn is_token_start(text: &str, index: usize) -> bool {
    index == 0 || PATH_DELIMITERS.contains(&text[..index].chars().next_back().unwrap_or(' '))
}

/// A mention token inside a longer text, with its byte range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MentionSpan {
    /// Byte offset of the `@`.
    pub start: usize,
    /// Byte offset just past the token's last byte.
    pub end: usize,
}

/// Every mention token in `text`.
///
/// Used to highlight mentions in the composer. A token ends at whitespace or
/// a closing quote, so `@src/main.rs` is one token and `mail@host` is not.
pub fn mention_spans(text: &str) -> Vec<MentionSpan> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'@' {
            index += 1;
            continue;
        }
        if !is_token_start(text, index) {
            index += 1;
            continue;
        }
        // A quoted path runs to the closing quote.
        let quoted = bytes.get(index + 1) == Some(&b'"');
        let mut end = if quoted { index + 2 } else { index + 1 };
        while end < bytes.len() {
            let byte = bytes[end];
            if quoted {
                if byte == b'"' {
                    end += 1;
                    break;
                }
            } else if PATH_DELIMITERS.contains(&(byte as char)) || byte == b'"' {
                break;
            }
            end += 1;
        }
        if end > index + 1 {
            spans.push(MentionSpan {
                start: index,
                end,
            });
            index = end;
        } else {
            index += 1;
        }
    }
    spans
}

/// The text a mention token contributes: the path without the `@`, and
/// whether it was opened with a quote.
pub fn mention_query(prefix: &str) -> (&str, bool) {
    let quoted = prefix.starts_with("@\"");
    let query = if quoted { &prefix[2..] } else { &prefix[1..] };
    (query, quoted)
}

/// The token inserted for a path. Paths with spaces are quoted so the mention
/// still reads as one token.
pub fn mention_value(path: &str, quoted: bool) -> String {
    if quoted || path.contains(' ') {
        format!("@\"{path}\"")
    } else {
        format!("@{path}")
    }
}

/// Score a path against the query, the same ranking the TUI applies so the
/// two frontends order results identically.
fn score_entry(path: &str, query: &str, is_directory: bool) -> u32 {
    let lower_query = query.to_ascii_lowercase();
    let file_name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();

    let mut score = if file_name == lower_query {
        100
    } else if file_name.starts_with(&lower_query) {
        80
    } else if file_name.contains(&lower_query) {
        50
    } else if path.to_ascii_lowercase().contains(&lower_query) {
        30
    } else {
        0
    };

    // A directory match edges out the file with the same name.
    if is_directory && score > 0 {
        score += 10;
    }
    score
}

/// Split `apps/doc` into "look under apps/ for doc".
///
/// Returns the directory to search and the query to match against entry
/// names. `None` when the query names no directory — then the whole working
/// directory is searched and the query is matched against full paths.
fn scoped_query(query: &str, root: &Path) -> Option<(PathBuf, String, String)> {
    let normalized = query.replace('\\', "/");
    let slash_index = normalized.rfind('/')?;
    let display_base = normalized[..=slash_index].to_string();
    let remainder = normalized[slash_index + 1..].to_string();

    let expanded = expand_home(&display_base);
    let base_dir = if Path::new(&expanded).is_absolute() {
        PathBuf::from(expanded)
    } else {
        root.join(&expanded)
    };
    if !base_dir.is_dir() {
        return None;
    }
    Some((base_dir, remainder, display_base))
}

/// Expand a leading `~` to the home directory.
fn expand_home(value: &str) -> String {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return value.to_string();
    };
    if value == "~" {
        return home.to_string_lossy().into_owned();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home.join(rest).to_string_lossy().into_owned();
    }
    value.to_string()
}

/// Walk `root` breadth-first, collecting files and directories.
fn walk(root: &Path, entries: &mut Vec<FileEntry>) {
    let mut queue: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    queue.push_back(String::new());

    while let Some(rel_dir) = queue.pop_front() {
        if entries.len() >= MAX_ENTRIES {
            return;
        }
        let dir = if rel_dir.is_empty() {
            root.to_path_buf()
        } else {
            root.join(&rel_dir)
        };
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue; // Unreadable directory — skip it.
        };
        let mut children: Vec<(String, bool)> = Vec::new();
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Symlinks are listed but never descended into: they can point at
            // the tree's own parent and make the walk cycle.
            let is_directory = if file_type.is_symlink() {
                false
            } else {
                file_type.is_dir()
            };
            if !is_directory && !file_type.is_file() && !file_type.is_symlink() {
                continue;
            }
            if is_directory && SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            children.push((name, is_directory));
        }
        // Sorted so the walk order does not depend on the filesystem's.
        children.sort();
        for (name, is_directory) in children {
            let rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            if is_directory {
                queue.push_back(rel.clone());
            }
            entries.push(FileEntry {
                path: rel,
                is_directory,
            });
            if entries.len() >= MAX_ENTRIES {
                return;
            }
        }
    }
}

/// The files under `root` matching `query`, best first.
///
/// An empty query returns the shallowest entries — what a bare `@` should
/// offer.
pub fn search_files(root: &Path, query: &str, limit: usize) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    walk(root, &mut entries);

    if query.is_empty() {
        entries.truncate(limit);
        return entries;
    }

    let mut scored: Vec<(u32, &FileEntry)> = entries
        .iter()
        .map(|entry| {
            (
                score_entry(&entry.path, query, entry.is_directory),
                entry,
            )
        })
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, entry)| entry.clone())
        .collect()
}

/// The picker rows for the mention under the cursor.
///
/// Returns an empty list when the cursor is not in an `@` token, or when the
/// working directory is unknown.
pub fn mention_candidates(
    text: &str,
    root: Option<&Path>,
    limit: usize,
) -> Vec<MentionCandidate> {
    let Some(prefix) = mention_prefix(text) else {
        return Vec::new();
    };
    let Some(root) = root else {
        return Vec::new();
    };
    let (query, quoted) = mention_query(prefix);
    let scoped = scoped_query(query, root);
    let (search_root, search_query, display_base) = match &scoped {
        Some((base_dir, remainder, display_base)) => {
            (base_dir.clone(), remainder.clone(), display_base.clone())
        }
        None => (
            root.to_path_buf(),
            query.replace('\\', "/"),
            String::new(),
        ),
    };

    search_files(&search_root, &search_query, limit)
        .into_iter()
        .map(|entry| {
            let display_path = if display_base.is_empty() {
                entry.path.clone()
            } else {
                format!("{display_base}{}", entry.path)
            };
            let suffix = if entry.is_directory { "/" } else { "" };
            let with_suffix = format!("{display_path}{suffix}");
            let label = display_path
                .rsplit('/')
                .next()
                .unwrap_or(&display_path)
                .to_string();
            MentionCandidate {
                value: mention_value(&with_suffix, quoted),
                label: format!("{label}{suffix}"),
                detail: display_path,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    #[test]
    fn mention_needs_a_word_boundary() {
        assert_eq!(mention_prefix("@src"), Some("@src"));
        assert_eq!(mention_prefix("look at @src/a"), Some("@src/a"));
        assert_eq!(mention_prefix("mail@host"), None);
        assert_eq!(mention_prefix("no mention"), None);
        assert_eq!(mention_prefix(""), None);
    }

    #[test]
    fn quoted_mentions_keep_their_spaces() {
        assert_eq!(mention_prefix("@\"my file.rs"), Some("@\"my file.rs"));
        assert_eq!(
            mention_query("@\"my file.rs"),
            ("my file.rs", true)
        );
        assert_eq!(mention_query("@src/a.rs"), ("src/a.rs", false));
    }

    #[test]
    fn closed_quote_ends_the_token() {
        assert_eq!(mention_prefix("@\"a.rs\" and more"), None);
    }

    #[test]
    fn values_quote_paths_with_spaces() {
        assert_eq!(mention_value("src/a.rs", false), "@src/a.rs");
        assert_eq!(mention_value("my docs/a b.rs", false), "@\"my docs/a b.rs\"");
        assert_eq!(mention_value("src/a.rs", true), "@\"src/a.rs\"");
    }

    #[test]
    fn search_ranks_file_name_over_path_matches() {
        let dir = temp_dir();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/agent.rs"), "").unwrap();
        fs::write(root.join("src/lib.rs"), "").unwrap();
        fs::write(root.join("agent-notes.md"), "").unwrap();

        // The file whose NAME matches outranks one that only matches on its
        // path, the same order the TUI's picker uses.
        let hits = search_files(root, "agent", 10);
        let paths: Vec<&str> = hits.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, vec!["agent-notes.md", "src/agent.rs"]);
    }

    #[test]
    fn walk_skips_dependency_and_build_directories() {
        let dir = temp_dir();
        let root = dir.path();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "").unwrap();

        let hits = search_files(root, "", 50);
        assert!(
            hits.iter().all(|entry| !entry.path.starts_with("node_modules")),
            "{hits:?}"
        );
        assert!(
            hits.iter().any(|entry| entry.path == "src/main.rs"),
            "{hits:?}"
        );
    }

    #[test]
    fn empty_query_returns_the_shallowest_entries() {
        let dir = temp_dir();
        let root = dir.path();
        fs::create_dir_all(root.join("a/b/c")).unwrap();
        fs::write(root.join("a/b/c/deep.rs"), "").unwrap();
        fs::write(root.join("top.rs"), "").unwrap();

        let hits = search_files(root, "", 5);
        let paths: Vec<&str> = hits.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths.first(), Some(&"a"));
        assert!(paths.contains(&"top.rs"), "{paths:?}");
    }

    #[test]
    fn candidates_carry_the_at_prefix_and_the_path() {
        let dir = temp_dir();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "").unwrap();

        let candidates = mention_candidates("look at @mai", Some(root), 10);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].value, "@src/main.rs");
        assert_eq!(candidates[0].label, "main.rs");
        assert_eq!(candidates[0].detail, "src/main.rs");
    }

    #[test]
    fn a_scoped_query_searches_under_that_directory() {
        let dir = temp_dir();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "").unwrap();
        fs::write(root.join("main.rs"), "").unwrap();

        let candidates = mention_candidates("@src/mai", Some(root), 10);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].value, "@src/main.rs");
    }

    #[test]
    fn no_mention_means_no_candidates() {
        let dir = temp_dir();
        assert!(mention_candidates("plain text", Some(dir.path()), 10).is_empty());
    }

    #[test]
    fn spans_find_every_mention_in_a_text() {
        let spans = mention_spans("look at @src/main.rs and @\"my file.rs\"");
        assert_eq!(
            spans,
            vec![
                MentionSpan {
                    start: 8,
                    end: 20
                },
                MentionSpan {
                    start: 25,
                    end: 38
                },
            ]
        );
        assert_eq!(&"look at @src/main.rs and @\"my file.rs\""[8..20], "@src/main.rs");
        assert_eq!(&"look at @src/main.rs and @\"my file.rs\""[25..38], "@\"my file.rs\"");
    }

    #[test]
    fn spans_ignore_a_bare_at_and_an_email() {
        assert!(mention_spans("@").is_empty());
        assert!(mention_spans("mail@host").is_empty());
    }

    #[test]
    fn a_missing_working_directory_means_no_candidates() {
        assert!(mention_candidates("@mai", None, 10).is_empty());
    }
}
