#!/usr/bin/env python3
"""Build version for CI artifact names: ``v<semver>-<short sha>``.

Reads the package version from ``Cargo.toml`` and appends the commit short
SHA so that several builds of one version stay distinguishable.

Where the result goes:

* On GitHub Actions ``GITHUB_OUTPUT`` is set; the script appends
  ``version=<build version>`` to that file, so a workflow step only needs to
  run this script. Capturing stdout instead would require one syntax for
  bash and another for PowerShell, and silent expansion quirks there have
  bitten this repository before.
* Locally ``GITHUB_OUTPUT`` is unset; the build version is printed to
  stdout for eyeballing.

Short SHA sources, in order:

1. ``GITHUB_SHA`` (always set by Actions; the merge commit SHA on
   ``pull_request`` events, which still distinguishes builds).
2. ``git rev-parse --short=7 HEAD`` (local fallback).
3. Neither available: plain ``v<semver>``; the script must not fail over a
   missing SHA.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

# The script lives in `.github/scripts/`, two levels below the repo root,
# so it works no matter which directory it is invoked from.
CARGO_TOML = Path(__file__).resolve().parents[2] / "Cargo.toml"


def cargo_version() -> str:
    """Return the `[package] version` string from Cargo.toml."""
    text = CARGO_TOML.read_text(encoding="utf-8")
    # First match wins: the package version precedes any dependency
    # `version = "..."` lines. Regex instead of tomllib to stay compatible
    # with runners whose Python predates 3.11.
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if match is None:
        sys.exit(f"error: no package version found in {CARGO_TOML}")
    return match.group(1)


def short_sha() -> str:
    """Return the 7-char commit SHA, or "" when no source is available."""
    sha = os.environ.get("GITHUB_SHA", "")
    if sha:
        return sha[:7]
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short=7", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return ""
    return result.stdout.strip()


def main() -> None:
    version = cargo_version()
    sha = short_sha()
    build_version = f"v{version}-{sha}" if sha else f"v{version}"

    output_file = os.environ.get("GITHUB_OUTPUT")
    if output_file:
        with open(output_file, "a", encoding="utf-8") as handle:
            handle.write(f"version={build_version}\n")
    else:
        print(build_version)


if __name__ == "__main__":
    main()
