//! Bridge that runs the front-end unit tests (`tests/js/*.test.js`) with
//! `node --test` from inside `cargo test`.
//!
//! The reader's pure logic (hash routing, search adapter) lives in plain
//! JavaScript ES modules, so it is tested with the runtime the product actually
//! uses instead of being duplicated in Rust. When `node` is not installed the
//! test prints a skip notice and passes, so the Rust suite stays runnable on a
//! machine without Node.
//!
//! The modules import the search engine with a bare `minisearch` specifier, so
//! the npm dependencies have to be installed (`npm ci`) before this test can
//! run; a missing `node_modules` is reported as a setup error, not a skip.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Directory holding the front-end test files.
const TEST_DIR: &str = "tests/js";

/// Test files, sorted, so the run is deterministic and an empty directory fails.
fn test_files(root: &Path) -> Vec<PathBuf> {
    let dir = root.join(TEST_DIR);
    let entries = std::fs::read_dir(&dir).expect("tests/js exists");

    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".test.js"))
        })
        .collect();

    files.sort();
    files
}

/// Whether `node` is on `PATH` and runnable.
fn node_is_available() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Fail early with an actionable message when `npm ci` has not run.
///
/// The reader's modules import the npm dependencies under `node --test`, so a
/// missing `node_modules` is a setup error rather than a test failure.
fn require_front_end_dependencies(root: &Path) {
    for relative in [
        "node_modules/minisearch/package.json",
        "node_modules/d3-force/package.json",
        "node_modules/d3-selection/package.json",
        "node_modules/d3-zoom/package.json",
        "node_modules/d3-drag/package.json",
        "node_modules/mermaid/package.json",
        "node_modules/esbuild/package.json",
    ] {
        let installed = root.join(relative);

        assert!(
            installed.is_file(),
            "the front-end dependencies are missing: run `npm ci` in {} first",
            root.display()
        );
    }
}

/// Number reported by the TAP summary line `# pass <n>`.
fn passed_count(stdout: &str) -> usize {
    stdout
        .lines()
        .find_map(|line| line.strip_prefix("# pass "))
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0)
}

#[test]
fn the_front_end_suite_passes() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let files = test_files(root);

    assert!(
        !files.is_empty(),
        "no front-end test files were found in {TEST_DIR}"
    );

    if !node_is_available() {
        eprintln!("skipping the front-end suite: node was not found on PATH");
        return;
    }
    require_front_end_dependencies(root);

    let output = Command::new("node")
        .arg("--test")
        .arg("--test-reporter=tap")
        .args(&files)
        .current_dir(root)
        .output()
        .unwrap_or_else(|error| panic!("failed to run node: {error}"));

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        output.status.success(),
        "the front-end suite failed\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}"
    );
    assert!(
        stdout.contains("# fail 0"),
        "the front-end suite reported a failure\n{stdout}"
    );
    assert!(
        passed_count(&stdout) >= files.len(),
        "only {} front-end tests ran for {} files\n{stdout}",
        passed_count(&stdout),
        files.len()
    );
}
