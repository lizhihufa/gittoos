use super::runner::{ensure_repo, run_git, run_git_timeout_nonblocking, GitBinary};
use super::types::{FileChange, GitError, RepoStatus};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub fn repo_status(git: &GitBinary, repo: &Path) -> Result<RepoStatus, GitError> {
    ensure_repo(git, repo)?;

    // Avoid `-uall`: on large trees it walks every untracked file and freezes the UI.
    // Normal mode lists untracked dirs as a single entry (much faster).
    let branch_out = run_git(
        git,
        repo,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=normal",
        ],
    )?;

    let (branch, is_detached, ahead, behind, changes) = parse_status_z(&branch_out.stdout);
    let operation = detect_operation(git, repo)?;

    Ok(RepoStatus {
        path: repo.display().to_string(),
        branch,
        is_detached,
        ahead,
        behind,
        operation,
        changes,
    })
}

/// Returns `Ok(None)` when another git command holds the global lock.
pub fn repo_status_light_nonblocking(
    git: &GitBinary,
    repo: &Path,
) -> Result<Option<RepoStatus>, GitError> {
    if !repo.exists() {
        return Err(GitError::InvalidPath(repo.display().to_string()));
    }
    let Some(branch_out) = run_git_timeout_nonblocking(
        git,
        repo,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=no",
        ],
        20,
    )?
    else {
        return Ok(None);
    };
    let (branch, is_detached, ahead, behind, changes) = parse_status_z(&branch_out.stdout);
    Ok(Some(RepoStatus {
        path: repo.display().to_string(),
        branch,
        is_detached,
        ahead,
        behind,
        operation: detect_operation_fs(repo),
        changes,
    }))
}

fn resolve_git_dir_fs(repo: &Path) -> PathBuf {
    let dot = repo.join(".git");
    if dot.is_dir() {
        return dot;
    }
    if dot.is_file() {
        if let Ok(text) = std::fs::read_to_string(&dot) {
            if let Some(rest) = text.strip_prefix("gitdir:") {
                let raw = rest.trim();
                let p = Path::new(raw);
                return if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    repo.join(p)
                };
            }
        }
    }
    dot
}

fn detect_operation_fs(repo: &Path) -> String {
    let dir = resolve_git_dir_fs(repo);
    if dir.join("rebase-merge").is_dir() || dir.join("rebase-apply").is_dir() {
        return "rebase".to_string();
    }
    if dir.join("CHERRY_PICK_HEAD").is_file() {
        return "cherry-pick".to_string();
    }
    if dir.join("MERGE_HEAD").is_file() {
        return "merge".to_string();
    }
    String::new()
}

fn detect_operation(git: &GitBinary, repo: &Path) -> Result<String, GitError> {
    let _ = git; // filesystem is enough and avoids extra processes
    Ok(detect_operation_fs(repo))
}

/// Parse `git status --porcelain=v2 -z` output into branch metadata and file changes.
pub fn parse_status_z(raw: &str) -> (String, bool, u32, u32, Vec<FileChange>) {
    let mut branch = "HEAD".to_string();
    let mut is_detached = false;
    let mut ahead = 0_u32;
    let mut behind = 0_u32;
    let mut map: BTreeMap<String, FileChange> = BTreeMap::new();

    let mut parts = raw.split('\0').filter(|p| !p.is_empty()).peekable();
    while let Some(entry) = parts.next() {
        if let Some(rest) = entry.strip_prefix("# branch.head ") {
            if rest == "(detached)" {
                is_detached = true;
                branch = "detached".to_string();
            } else {
                branch = rest.to_string();
            }
            continue;
        }
        if let Some(rest) = entry.strip_prefix("# branch.ab ") {
            // format: +<ahead> -<behind>
            for token in rest.split_whitespace() {
                if let Some(n) = token.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = token.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if entry.starts_with('#') {
            continue;
        }

        let bytes = entry.as_bytes();
        if bytes.is_empty() {
            continue;
        }

        match bytes[0] {
            b'1' => {
                // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
                let fields: Vec<&str> = entry.splitn(9, ' ').collect();
                if fields.len() < 9 {
                    continue;
                }
                let xy = fields[1];
                let path = fields[8].to_string();
                let x = xy.chars().next().unwrap_or('.');
                let y = xy.chars().nth(1).unwrap_or('.');
                upsert(&mut map, path, x, y, false);
            }
            b'2' => {
                // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
                let fields: Vec<&str> = entry.splitn(10, ' ').collect();
                if fields.len() < 10 {
                    continue;
                }
                let xy = fields[1];
                let path = fields[9].to_string();
                let _orig = parts.next();
                let x = xy.chars().next().unwrap_or('.');
                let y = xy.chars().nth(1).unwrap_or('.');
                upsert(&mut map, path, x, y, false);
            }
            b'u' => {
                // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
                let fields: Vec<&str> = entry.splitn(11, ' ').collect();
                if fields.len() < 11 {
                    continue;
                }
                let xy = fields[1];
                let path = fields[10].to_string();
                let x = xy.chars().next().unwrap_or('U');
                let y = xy.chars().nth(1).unwrap_or('U');
                upsert(&mut map, path, x, y, true);
            }
            b'?' => {
                // untracked: "? <path>"
                let path = entry.trim_start_matches("? ").to_string();
                map.entry(path.clone()).or_insert(FileChange {
                    path,
                    status: "??".to_string(),
                    staged: false,
                    unstaged: true,
                    untracked: true,
                    conflicted: false,
                });
            }
            b'!' => {
                // ignored — skip
            }
            _ => {}
        }
    }

    let changes = map.into_values().collect();
    (branch, is_detached, ahead, behind, changes)
}

fn upsert(map: &mut BTreeMap<String, FileChange>, path: String, x: char, y: char, conflicted: bool) {
    let staged = x != '.' && x != ' ';
    let unstaged = y != '.' && y != ' ';
    let status = format!("{x}{y}");
    map.insert(
        path.clone(),
        FileChange {
            path,
            status,
            staged,
            unstaged,
            untracked: false,
            conflicted: conflicted || x == 'U' || y == 'U',
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_modified_file() {
        let raw = concat!(
            "# branch.head main\0",
            "# branch.ab +1 -0\0",
            "1 .M N... 100644 100644 100644 abcdef1 abcdef2 README.md\0",
            "? new.txt\0",
        );
        let (branch, detached, ahead, behind, changes) = parse_status_z(raw);
        assert_eq!(branch, "main");
        assert!(!detached);
        assert_eq!(ahead, 1);
        assert_eq!(behind, 0);
        assert_eq!(changes.len(), 2);
        let readme = changes.iter().find(|c| c.path == "README.md").unwrap();
        assert!(readme.unstaged);
        assert!(!readme.staged);
        let new = changes.iter().find(|c| c.path == "new.txt").unwrap();
        assert!(new.untracked);
    }
}
