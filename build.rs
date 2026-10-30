//! Build script: bundle the front-end sources into the single script that the
//! reader inlines.
//!
//! The reader has to be a single self-contained page, so every script is inlined
//! with `include_str!`. The front-end sources are ES modules that import the
//! third-party engines from `node_modules`, so they cannot be concatenated: this
//! script runs the npm-installed esbuild once and stages the resulting IIFE
//! bundle in `OUT_DIR`, which is the only place `src/render.rs` reads it from.
//!
//! The script deliberately does not run `npm`: a build either finds the
//! dependencies already installed or fails with an actionable message. Byte
//! identity of the bundle is delegated to `package-lock.json` (which pins the
//! bundler and the libraries); this script only checks that they are present.
//!
//! The bundle is minified. `mermaid` is two orders of magnitude larger than the
//! rest of the front end, so unminified output would be ~12 MB in every page;
//! minification is deterministic, so byte identity across builds is unaffected,
//! and the only cost is that reader identifiers no longer survive in the output
//! (tests therefore assert on string literals and attribute names instead).
//!
//! Upgrading a library or the bundler: edit `package.json`, run `npm ci`, build.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, exit};

/// Bundle entry point, relative to the crate root.
///
/// It imports the reader modules, which import `minisearch`; esbuild resolves
/// the whole graph and emits one IIFE.
const ENTRY: &str = "src/web/js/main.js";

/// Launcher installed by the `esbuild` npm dependency.
///
/// Called through `node` on purpose: `node_modules/.bin/esbuild` is a shell
/// shim (`.cmd` on Windows) that `Command::new` cannot execute directly, while
/// this file is plain JavaScript and works the same on every platform.
const ESBUILD_BIN: &str = "node_modules/esbuild/bin/esbuild";

/// Manifests of the third-party packages the bundle imports.
///
/// All of them are checked before bundling, so a stale install fails with the
/// `npm ci` instruction instead of an esbuild resolution error. The `d3`
/// modules are ordinary ESM packages: `d3-force` lays the link graph out and
/// `d3-selection`/`d3-zoom`/`d3-drag` provide its interaction. `mermaid`
/// renders diagram fences; it is the only dependency whose own manifest also
/// pulls a large tree (its diagram chunks plus `elkjs`, `cytoscape`, `katex`).
const REQUIRED_MANIFESTS: [&str; 6] = [
    "node_modules/minisearch/package.json",
    "node_modules/d3-force/package.json",
    "node_modules/d3-selection/package.json",
    "node_modules/d3-zoom/package.json",
    "node_modules/d3-drag/package.json",
    "node_modules/mermaid/package.json",
];

/// Bundler manifest, watched so an upgrade triggers a rebuild.
const ESBUILD_MANIFEST: &str = "node_modules/esbuild/package.json";

/// Staged bundle inside `OUT_DIR`, consumed by `src/render.rs`.
const BUNDLE_STAGED: &str = "vendor/app.js";

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));

    // Printed before any work: the default "watch the whole crate" behaviour is
    // replaced as soon as a `rerun-if-changed` is emitted, so the build script
    // re-runs exactly when a front-end source or a declaration changes.
    for watched in ["src/web/js", "package.json", "package-lock.json"]
        .into_iter()
        .chain(REQUIRED_MANIFESTS)
        .chain([ESBUILD_MANIFEST])
    {
        println!("cargo:rerun-if-changed={watched}");
    }

    if let Err(message) = bundle(root) {
        eprintln!("error: cannot bundle the front-end sources: {message}");
        eprintln!();
        eprintln!(
            "The bundler and the front-end libraries are npm dependencies. Install \
             them once in `{}` with `npm ci`, then build again.",
            root.display()
        );
        exit(1);
    }
}

/// Run esbuild over [`ENTRY`] and write the IIFE bundle into `OUT_DIR`.
fn bundle(root: &Path) -> Result<(), String> {
    let esbuild = root.join(ESBUILD_BIN);
    if !esbuild.is_file() {
        return Err(format!(
            "{} is missing: the esbuild npm dependency is not installed",
            esbuild.display()
        ));
    }

    for manifest in REQUIRED_MANIFESTS {
        let path = root.join(manifest);
        if !path.is_file() {
            return Err(format!(
                "{} is missing: a front-end npm dependency is not installed",
                path.display()
            ));
        }
    }

    let entry = root.join(ENTRY);
    if !entry.is_file() {
        return Err(format!("{} is missing", entry.display()));
    }

    let out_dir = env::var("OUT_DIR")
        .map_err(|error| format!("OUT_DIR is not set: {error}"))
        .map(PathBuf::from)?;
    let staged = out_dir.join(BUNDLE_STAGED);

    if let Some(parent) = staged.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }

    // `--format=iife` because the page inlines a classic script. `--minify` is
    // what keeps the page weight sane: the diagram engine alone is ~12 MB
    // unminified and ~5 MB minified. It is deterministic, so byte identity is
    // preserved; no source map, so no absolute path can be baked in.
    let output = Command::new("node")
        .arg(&esbuild)
        .arg(&entry)
        .args([
            "--bundle",
            "--format=iife",
            "--platform=browser",
            "--target=es2020",
            "--charset=utf8",
            "--minify",
            "--log-level=warning",
        ])
        .arg(format!("--outfile={}", staged.display()))
        .current_dir(root)
        .output()
        .map_err(|error| format!("cannot run node: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "esbuild exited with {}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim_end()
        ));
    }

    if !staged.is_file() {
        return Err(format!(
            "esbuild reported success but {} was not written",
            staged.display()
        ));
    }

    verify_self_contained(&staged)?;

    Ok(())
}

/// Marker of a diagram chunk that esbuild failed to inline.
///
/// `mermaid` loads its diagram implementations through `import()` with static
/// chunk paths. esbuild inlines those into the single IIFE as long as code
/// splitting is off; if a chunk path survives, the page would try to fetch a
/// sibling file at runtime and the offline guarantee would be silently broken.
const LEFTOVER_CHUNK: &str = "chunks/mermaid.core/";

/// Reject a bundle that would need to load another file at runtime.
fn verify_self_contained(staged: &Path) -> Result<(), String> {
    let bundle = fs::read_to_string(staged)
        .map_err(|error| format!("cannot read {}: {error}", staged.display()))?;

    if bundle.contains(LEFTOVER_CHUNK) {
        return Err(format!(
            "the bundle still references `{LEFTOVER_CHUNK}`: a dynamic import was not inlined, \
             so the page would fetch a file at runtime"
        ));
    }
    if bundle.contains("</script") {
        return Err("the bundle contains a `</script` sequence and cannot be inlined".to_string());
    }

    Ok(())
}
