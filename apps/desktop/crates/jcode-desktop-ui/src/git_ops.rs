//! Git subprocess calls backing the Source Control panel. Mirrors
//! `panel_commands.rs`'s `git_read` Command setup (same flags, same
//! no-console-window/optional-locks handling) but returns structured data
//! and adds the write operations `git_read` has no need for.
use jcode_desktop_model::git_status::{self, GitFile, GitStatus};

/// Git's well-known empty tree object hash, the same in every repository
/// regardless of history — stands in for HEAD before a repo's first commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn command(directory: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = std::process::Command::new("git");
    command
        .current_dir(directory)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["--no-pager", "-c", "color.ui=false", "-c", "core.fsmonitor=false"])
        .args(args);
    jcode_desktop_harness::platform::no_console_window(&mut command);
    command
        .output()
        .map_err(|error| format!("Could not run git: {error}"))
}

fn text(directory: &str, args: &[&str]) -> Result<String, String> {
    let output = command(directory, args)?;
    if !output.status.success() {
        return Err(format!(
            "Git failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub(crate) fn status(directory: &str) -> Result<GitStatus, String> {
    let output = text(
        directory,
        &["status", "--short", "--branch", "--untracked-files=normal"],
    )?;
    Ok(git_status::parse(&output))
}

pub(crate) fn diff(directory: &str, path: &str, staged: bool) -> Result<String, String> {
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(path);
    text(directory, &args)
}

/// Diff against the last commit, covering both staged and unstaged changes
/// to a tracked file in one call. This is what "changed this turn" means —
/// unlike the Source Control panel's staged/unstaged split, which is about
/// what's ready to commit, not what happened. Untracked files show nothing
/// here (plain `git diff` never reads them); the turn summary still lists
/// them, just without a usable diff body.
///
pub(crate) fn diff_since_head(directory: &str, path: &str) -> Result<String, String> {
    match text(
        directory,
        &["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--", path],
    ) {
        // A brand-new repo has no HEAD to diff against. Git's well-known empty
        // tree object (present in every repository, independent of any
        // commit) stands in for it, covering staged and unstaged alike —
        // unlike falling back to `diff(.., false)`, which misses a file
        // staged ahead of this repo's first commit.
        Err(error)
            if error.contains("unknown revision")
                || error.contains("ambiguous argument")
                || error.contains("bad revision") =>
        {
            text(
                directory,
                &[
                    "diff",
                    EMPTY_TREE,
                    "--no-ext-diff",
                    "--no-textconv",
                    "--",
                    path,
                ],
            )
        }
        result => result,
    }
}

/// Total added/removed lines across every tracked change since HEAD, in one
/// subprocess call rather than one per changed file.
pub(crate) fn numstat_since_head(directory: &str) -> Result<(usize, usize), String> {
    let output = text(directory, &["diff", "HEAD", "--numstat"])?;
    let mut additions = 0usize;
    let mut deletions = 0usize;
    for line in output.lines() {
        let mut columns = line.splitn(3, '\t');
        let added = columns.next().unwrap_or("0");
        let removed = columns.next().unwrap_or("0");
        additions += added.parse().unwrap_or(0);
        deletions += removed.parse().unwrap_or(0);
    }
    Ok((additions, deletions))
}

/// A fabricated unified diff for an untracked file. Plain `git diff` never
/// reads untracked content, so there is nothing else to show one as; this
/// builds a real (if synthetic) patch and lets the existing
/// `diff_model::from_patch` parser render it as an all-additions file, same
/// as any other diff.
pub(crate) fn untracked_file_diff(directory: &str, path: &str) -> Result<String, String> {
    let content = std::fs::read_to_string(std::path::Path::new(directory).join(path))
        .map_err(|error| format!("Could not read {path}: {error}"))?;
    let line_count = content.lines().count().max(1);
    let mut patch = format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{line_count} @@\n");
    for line in content.lines() {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    Ok(patch)
}

/// `git add` (stage) or `git reset` (unstage) for exactly these paths —
/// never the whole tree, even when the caller means "stage everything".
pub(crate) fn stage(directory: &str, paths: &[String], staged: bool) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec![if staged { "add" } else { "reset" }, "--"];
    args.extend(paths.iter().map(String::as_str));
    text(directory, &args).map(drop)
}

pub(crate) fn commit(directory: &str, message: &str) -> Result<(), String> {
    text(directory, &["commit", "-m", message]).map(drop)
}

/// Last-modified time of each listed file, keyed by path. Used alongside a
/// git status snapshot to tell "still dirty from before" apart from "edited
/// again this turn" — the status letters alone can't, since they don't
/// change when an already-modified file is modified further. A file that
/// vanished (deleted, or the directory moved) is simply absent from the map.
pub(crate) fn mtimes(
    directory: &str,
    files: &[GitFile],
) -> std::collections::HashMap<String, std::time::SystemTime> {
    files
        .iter()
        .filter_map(|file| {
            let modified = std::fs::metadata(std::path::Path::new(directory).join(&file.path))
                .and_then(|metadata| metadata.modified())
                .ok()?;
            Some((file.path.clone(), modified))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init(directory: &std::path::Path) {
        for args in [
            vec!["init", "--quiet"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
        ] {
            assert!(
                std::process::Command::new("git")
                    .args(&args)
                    .current_dir(directory)
                    .status()
                    .unwrap()
                    .success()
            );
        }
    }

    #[test]
    fn status_diff_stage_and_commit_round_trip_on_a_real_repository() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path();
        init(directory);
        let path = directory.to_str().unwrap();
        std::fs::write(directory.join("a.txt"), "hello\n").unwrap();

        let found = status(path).unwrap();
        assert_eq!(found.files.len(), 1);
        assert_eq!(found.files[0].path, "a.txt");
        assert!(!git_status::is_staged(&found.files[0]));
        assert!(git_status::is_unstaged(&found.files[0]));

        stage(path, &["a.txt".into()], true).unwrap();
        let staged = status(path).unwrap();
        assert!(git_status::is_staged(&staged.files[0]));
        assert!(!git_status::is_unstaged(&staged.files[0]));
        assert!(diff(path, "a.txt", true).unwrap().contains("+hello"));

        commit(path, "add a.txt").unwrap();
        assert!(status(path).unwrap().files.is_empty());

        std::fs::write(directory.join("a.txt"), "hello\nworld\n").unwrap();
        stage(path, &["a.txt".into()], true).unwrap();
        stage(path, &["a.txt".into()], false).unwrap();
        let after_unstage = status(path).unwrap();
        assert!(!git_status::is_staged(&after_unstage.files[0]));
        assert!(git_status::is_unstaged(&after_unstage.files[0]));
    }

    #[test]
    fn diff_since_head_and_numstat_cover_staged_and_unstaged_together() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path();
        init(directory);
        let path = directory.to_str().unwrap();
        std::fs::write(directory.join("a.txt"), "one\n").unwrap();
        stage(path, &["a.txt".into()], true).unwrap();
        commit(path, "add a.txt").unwrap();

        std::fs::write(directory.join("a.txt"), "one\ntwo\n").unwrap();
        stage(path, &["a.txt".into()], true).unwrap();
        std::fs::write(directory.join("b.txt"), "unstaged\n").unwrap();

        let diff_text = diff_since_head(path, "a.txt").unwrap();
        assert!(diff_text.contains("+two"));

        let (additions, deletions) = numstat_since_head(path).unwrap();
        assert_eq!(additions, 1);
        assert_eq!(deletions, 0);
    }

    #[test]
    fn diff_since_head_falls_back_to_the_working_tree_before_the_first_commit() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path();
        init(directory);
        let path = directory.to_str().unwrap();
        std::fs::write(directory.join("a.txt"), "hello\n").unwrap();
        // `git diff` never reads untracked content either way — stage it so
        // this actually exercises the no-HEAD fallback, not the untracked case.
        stage(path, &["a.txt".into()], true).unwrap();

        let diff_text = diff_since_head(path, "a.txt").unwrap();
        assert!(diff_text.contains("+hello"));
    }

    #[test]
    fn untracked_file_diff_renders_the_whole_file_as_additions() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path();
        init(directory);
        std::fs::write(directory.join("new.txt"), "one\ntwo\n").unwrap();

        let patch = untracked_file_diff(directory.to_str().unwrap(), "new.txt").unwrap();
        assert!(patch.contains("+one"));
        assert!(patch.contains("+two"));
    }
}
