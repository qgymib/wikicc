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
//!
//! ## Which esbuild
//!
//! `node_modules/esbuild/bin/esbuild` is *not* one thing. Windows keeps the
//! npm-installed JavaScript launcher there, while a POSIX install replaces that
//! same path with a copy of the native executable (esbuild's `postinstall` links
//! `@esbuild/<platform>-<arch>` over it), so running it through `node` fails on
//! Linux with `SyntaxError: Invalid or unexpected token`. [`locate`] therefore
//! resolves the launcher the way esbuild's own install script does and reports
//! how it has to be started; only a script goes through `node`.

use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, exit};

/// Bundle entry point, relative to the crate root.
///
/// It imports the reader modules, which import `minisearch`; esbuild resolves
/// the whole graph and emits one IIFE.
const ENTRY: &str = "src/web/js/main.js";

/// Platform-specific package that carries the native esbuild executable.
///
/// esbuild is written in Go, so the executable itself is shipped by an
/// `optionalDependencies` package named after the platform; the installer hoists
/// exactly this package for the machine it runs on.
const NATIVE_PACKAGE_PREFIX: &str = "node_modules/@esbuild/";

/// Directory holding the executable that npm's `.bin` shim points at.
///
/// `node_modules/.bin/esbuild` is a shell shim (`.cmd` on Windows) that
/// `Command::new` cannot execute directly, so the target is resolved instead.
const LAUNCHER_DIR: &str = "node_modules/esbuild/bin";

/// Launcher file name, without the extension the platform-specific package uses.
const LAUNCHER_NAME: &str = "esbuild";

/// Installer directory, which holds the direct download fallback.
const INSTALLER_LIB: &str = "node_modules/esbuild/lib";

/// Prefix of the binary the installer downloads when the native package is
/// missing, matching esbuild's own `downloadedBinPath`.
const DOWNLOADED_PREFIX: &str = "downloaded-";

/// Path esbuild itself refuses to honour in `ESBUILD_BINARY_PATH`.
///
/// It is the name of the executable a distribution package would install, so a
/// stale value in a shell profile must not silently pick an unrelated version.
const IGNORED_OVERRIDE: &str = "/usr/bin/esbuild";

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

/// Marker of a diagram chunk that esbuild failed to inline.
///
/// `mermaid` loads its diagram implementations through `import()` with static
/// chunk paths. esbuild inlines those into the single IIFE as long as code
/// splitting is off; if a chunk path survives, the page would try to fetch a
/// sibling file at runtime and the offline guarantee would be silently broken.
const LEFTOVER_CHUNK: &str = "chunks/mermaid.core/";

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

    let override_path = env::var_os("ESBUILD_BINARY_PATH").map(PathBuf::from);

    if let Err(message) = bundle(root, Platform::host(), override_path.as_deref()) {
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

/// Target triple esbuild ships a native executable for.
///
/// Only the pair matters: esbuild names its platform packages `<os>-<cpu>`, so
/// the pair is carried explicitly rather than read from the environment at each
/// call site, and the package name follows from it alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Platform {
    /// `std::env::consts::OS` on the host, e.g. `linux`.
    os: &'static str,
    /// `std::env::consts::ARCH` on the host, e.g. `x86_64`.
    arch: &'static str,
}

impl Platform {
    /// Platform the build is running on.
    fn host() -> Self {
        Self {
            os: env::consts::OS,
            arch: env::consts::ARCH,
        }
    }

    /// Package suffix, e.g. `linux-x64`, or the host pair when esbuild ships
    /// nothing for it (the caller then has no package to look at).
    fn name(self) -> String {
        self.package_suffix()
            .unwrap_or_else(|| format!("{}-{}", self.os, self.arch))
    }

    /// Package suffix, e.g. `linux-x64`.
    ///
    /// The CPU is spelled the way Node's `os.arch()` spells it, which is what
    /// esbuild's installer keys its package table on, not the way Rust's
    /// `std::env::consts::ARCH` does (`x86_64`, `aarch64`).
    fn package_suffix(self) -> Option<String> {
        let cpu = match self.arch {
            "x86_64" => "x64",
            "x86" | "i686" => "ia32",
            "aarch64" => "arm64",
            "arm" => "arm",
            other => other,
        };
        let os = self.os;

        // Only the combinations esbuild publishes; anything else has no native
        // package and falls through to the remaining candidates.
        Some(match (os, cpu) {
            ("linux", "x64" | "arm64" | "arm" | "ia32" | "loong64" | "s390x" | "riscv64") => {
                format!("{os}-{cpu}")
            }
            ("darwin", "x64" | "arm64") => format!("{os}-{cpu}"),
            ("win32", "x64" | "arm64" | "ia32") => format!("{os}-{cpu}"),
            ("freebsd" | "netbsd" | "openbsd" | "sunos", "x64" | "arm64") => format!("{os}-{cpu}"),
            ("aix", "ppc64") => format!("{os}-{cpu}"),
            _ => return None,
        })
    }

    /// File name of the native executable, which the platform package nests
    /// either at its root (`win32-*`) or under `bin/`.
    fn executable_subpath(self) -> &'static str {
        if self.os == "win32" {
            "esbuild.exe"
        } else {
            "bin/esbuild"
        }
    }

    /// Prefix esbuild's installer gives a binary it downloaded itself, e.g.
    /// `downloaded-@esbuild-linux-x64-esbuild`.
    fn downloaded_name(self, suffix: &str) -> String {
        let executable = self
            .executable_subpath()
            .rsplit('/')
            .next()
            .unwrap_or(LAUNCHER_NAME);

        format!("{DOWNLOADED_PREFIX}@esbuild-{suffix}-{executable}")
    }
}

/// How esbuild has to be started.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Launcher {
    /// Native executable: run it directly.
    Binary(PathBuf),
    /// JavaScript launcher: run it with `node`, the only interpreter guaranteed
    /// to be present (it is an npm prerequisite anyway).
    Script(PathBuf),
}

/// Resolve the esbuild executable to run.
///
/// The order is esbuild's own: an explicit `ESBUILD_BINARY_PATH`, then the
/// platform package, then the installer's direct download, then the launcher npm
/// installed. Nothing here reads the environment or writes to disk: the root and
/// the platform are both passed in.
fn locate(
    root: &Path,
    platform: Platform,
    override_path: Option<&Path>,
) -> Result<Launcher, String> {
    if let Some(override_path) = override_path {
        let usable = !override_path.as_os_str().is_empty()
            && override_path.to_str() != Some(IGNORED_OVERRIDE)
            && override_path.is_file();

        if usable {
            return Ok(Launcher::Binary(override_path.to_path_buf()));
        }
    }

    // The platform package and the installer's own download, in that order.
    let package = platform.package_suffix().map(|suffix| {
        [
            root.join(NATIVE_PACKAGE_PREFIX)
                .join(&suffix)
                .join(platform.executable_subpath()),
            root.join(INSTALLER_LIB)
                .join(platform.downloaded_name(&suffix)),
        ]
    });

    for candidate in package.into_iter().flatten() {
        if candidate.is_file() {
            return Ok(Launcher::Binary(candidate));
        }
    }

    let launcher = root.join(LAUNCHER_DIR).join(LAUNCHER_NAME);
    if launcher.is_file() {
        return Ok(if is_script(&launcher)? {
            Launcher::Script(launcher)
        } else {
            Launcher::Binary(launcher)
        });
    }

    Err(format!(
        "no esbuild executable was found under {}: the `@esbuild/{}` package and \
         `{}` are both absent",
        root.display(),
        platform.name(),
        root.join(LAUNCHER_DIR).join(LAUNCHER_NAME).display()
    ))
}

/// Whether `path` is a script rather than a native executable.
///
/// esbuild's POSIX installer replaces the launcher with the native binary, so the
/// file name says nothing: the shebang decides. The check is a size and prefix
/// read, not a load, because the file may be a multi-megabyte executable.
fn is_script(path: &Path) -> Result<bool, String> {
    let mut head = [0u8; 2];
    let mut file =
        fs::File::open(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let mut read = 0;

    while read < head.len() {
        match file.read(&mut head[read..]) {
            Ok(0) => break,
            Ok(count) => read += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
        }
    }

    // A native executable's first bytes are an ELF/Mach-O/PE header, never `#!`.
    Ok(head.starts_with(b"#!"))
}

/// Run esbuild over [`ENTRY`] and write the IIFE bundle into `OUT_DIR`.
fn bundle(root: &Path, platform: Platform, override_path: Option<&Path>) -> Result<(), String> {
    for manifest in REQUIRED_MANIFESTS.iter().copied().chain([ESBUILD_MANIFEST]) {
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

    let launcher = locate(root, platform, override_path)?;

    let staged =
        PathBuf::from(env::var("OUT_DIR").map_err(|error| format!("OUT_DIR is not set: {error}"))?)
            .join(BUNDLE_STAGED);

    if let Some(parent) = staged.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }

    // `--format=iife` because the page inlines a classic script. `--minify` is
    // what keeps the page weight sane: the diagram engine alone is ~12 MB
    // unminified and ~5 MB minified. It is deterministic, so byte identity is
    // preserved; no source map, so no absolute path can be baked in.
    let args = [
        "--bundle",
        "--format=iife",
        "--platform=browser",
        "--target=es2020",
        "--charset=utf8",
        "--minify",
        "--log-level=warning",
    ];

    let mut command = match &launcher {
        Launcher::Binary(binary) => Command::new(binary),
        Launcher::Script(script) => {
            let mut command = Command::new("node");
            command.arg(script);
            command
        }
    };

    let output = command
        .arg(&entry)
        .args(args)
        .arg(format!("--outfile={}", staged.display()))
        .current_dir(root)
        .output()
        .map_err(|error| match &launcher {
            Launcher::Binary(binary) => format!("cannot run {}: {error}", binary.display()),
            Launcher::Script(script) => format!("cannot run node {}: {error}", script.display()),
        })?;

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
