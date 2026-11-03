//! Parses `git status --short --branch --untracked-files=normal` (porcelain
//! v1) output into structured data, presentation-independent like the rest of
//! this crate. No filesystem or process access — the caller runs `git` and
//! hands the raw stdout here.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitFile {
    pub path: String,
    /// Staged (index) status column: ' ' if none, '?' if untracked.
    pub index: char,
    /// Unstaged (working tree) status column: ' ' if none.
    pub working: char,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub files: Vec<GitFile>,
}

pub fn is_staged(file: &GitFile) -> bool {
    !matches!(file.index, ' ' | '?' | '!')
}

pub fn is_unstaged(file: &GitFile) -> bool {
    !matches!(file.working, ' ' | '!') || file.index == '?'
}

/// ponytail: doesn't unquote `core.quotepath`-escaped paths (rare: non-ASCII
/// or paths containing a literal `"`). Widen this if a real repo trips it.
pub fn parse(output: &str) -> GitStatus {
    let mut branch = None;
    let mut files = Vec::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let name = rest
                .split(['.', ' ', '('])
                .next()
                .filter(|name| !name.is_empty() && *name != "HEAD");
            branch = name.map(str::to_owned).or(branch);
            continue;
        }
        let mut chars = line.chars();
        let Some(index) = chars.next() else { continue };
        let Some(working) = chars.next() else {
            continue;
        };
        let Some(rest) = line.get(3..) else { continue };
        // A rename/copy keeps `old -> new` on one line; only the new path matters here.
        let path = rest.rsplit_once(" -> ").map_or(rest, |(_, new)| new);
        files.push(GitFile {
            path: path.to_owned(),
            index,
            working,
        });
    }
    GitStatus { branch, files }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_header_is_read_and_excluded_from_files() {
        let status = parse("## main...origin/main [ahead 1]\n M src/lib.rs\n");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.files, [GitFile {
            path: "src/lib.rs".into(),
            index: ' ',
            working: 'M',
        }]);
    }

    #[test]
    fn detached_head_has_no_branch() {
        let status = parse("## HEAD (no branch)\n");
        assert_eq!(status.branch, None);
    }

    #[test]
    fn staged_unstaged_and_untracked_are_classified() {
        let status = parse("M  staged.rs\n M unstaged.rs\nMM both.rs\n?? new.rs\n");
        let find = |path: &str| status.files.iter().find(|f| f.path == path).unwrap();
        assert!(is_staged(find("staged.rs")) && !is_unstaged(find("staged.rs")));
        assert!(!is_staged(find("unstaged.rs")) && is_unstaged(find("unstaged.rs")));
        assert!(is_staged(find("both.rs")) && is_unstaged(find("both.rs")));
        assert!(!is_staged(find("new.rs")) && is_unstaged(find("new.rs")));
    }

    #[test]
    fn rename_keeps_only_the_new_path() {
        let status = parse("R  old.rs -> new.rs\n");
        assert_eq!(status.files[0].path, "new.rs");
    }

    #[test]
    fn empty_output_is_a_clean_tree() {
        let status = parse("## main\n");
        assert!(status.files.is_empty());
    }
}
