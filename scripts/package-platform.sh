#!/usr/bin/env bash
# Bundle the `sumo-lsp` and `sumo` binaries into this extension and
# produce a platform-specific VSIX.
#
# Usage:
#
#     scripts/package-platform.sh <target-triple> <sumo-lsp-path> [<sumo-path>]
#
#     scripts/package-platform.sh aarch64-apple-darwin            \
#         ~/projects/sigma-rs/target/release/sumo-lsp
#
#     scripts/package-platform.sh x86_64-unknown-linux-gnu        \
#         ./artifacts/linux/sumo-lsp                              \
#         ./artifacts/linux/sumo
#
# The script:
#
#   1. Maps the Rust-style target triple to the VSCE platform ID
#      (darwin-arm64, darwin-x64, linux-x64, win32-x64, ...).
#   2. Copies `<sumo-lsp-path>` into `server/sumo-lsp(.exe)`.
#   3. Copies `<sumo-path>` (or, if omitted, the `sumo` binary
#      sitting next to `<sumo-lsp-path>`) into `server/sumo(.exe)`.
#      This is the ask/tell kernel that the extension spawns
#      lazily from `kernelClient.ts`; see the `sumo serve`
#      subcommand in `crates/native/src/cli/serve.rs`.
#   4. Marks both binaries executable on POSIX.
#   5. Runs `npm ci && npm run compile && vsce package --target <id>`.
#
# Vampire is *not* bundled -- it's a separate C++ solver the user
# installs via their package manager (brew, apt, ...) or a pre-built
# release from the vprover repo.  The kernel resolves `vampire` on
# PATH at startup and surfaces a friendly error per-ask if it's
# missing, so a missing Vampire doesn't break activation.
#
# Artefacts land next to package.json as
# `sumo-vscode-<version>-<platform>.vsix`.

set -euo pipefail

if [[ "$#" -lt 2 ]]; then
    echo "usage: $0 <target-triple> <sumo-lsp-binary-path> [<sumo-binary-path>]" >&2
    echo "example: $0 aarch64-apple-darwin ../sigma-rs/target/release/sumo-lsp" >&2
    echo "         (auto-detects ../sigma-rs/target/release/sumo as the kernel)" >&2
    exit 2
fi

TRIPLE="$1"
LSP_BINARY="$2"
# Kernel binary: explicit third arg, or sibling of the LSP binary.
KERNEL_BINARY="${3:-$(dirname "${LSP_BINARY}")/sumo}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${TRIPLE}" in
    aarch64-apple-darwin)          VSCE_TARGET="darwin-arm64"   ;;
    x86_64-apple-darwin)           VSCE_TARGET="darwin-x64"     ;;
    x86_64-unknown-linux-gnu)      VSCE_TARGET="linux-x64"      ;;
    aarch64-unknown-linux-gnu)     VSCE_TARGET="linux-arm64"    ;;
    x86_64-pc-windows-msvc)        VSCE_TARGET="win32-x64"      ;;
    *)
        echo "error: unrecognised target triple '${TRIPLE}'" >&2
        echo "supported: aarch64-apple-darwin, x86_64-apple-darwin," >&2
        echo "           x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu," >&2
        echo "           x86_64-pc-windows-msvc" >&2
        exit 2
        ;;
esac

if [[ ! -f "${LSP_BINARY}" ]]; then
    echo "error: sumo-lsp binary not found at '${LSP_BINARY}'" >&2
    exit 1
fi
if [[ ! -f "${KERNEL_BINARY}" ]]; then
    echo "error: sumo kernel binary not found at '${KERNEL_BINARY}'" >&2
    echo "hint: build it with \`cargo build --release -p sumo-native --bin sumo\` in sigma-rs," >&2
    echo "      or pass its path explicitly as the third argument." >&2
    exit 1
fi

# Stage both binaries into the extension's `server/` drop directory.
# Windows targets get an `.exe` suffix; everything else is bare.
if [[ "${VSCE_TARGET}" == win32-* ]]; then
    LSP_DEST="${ROOT}/server/sumo-lsp.exe"
    KERNEL_DEST="${ROOT}/server/sumo.exe"
else
    LSP_DEST="${ROOT}/server/sumo-lsp"
    KERNEL_DEST="${ROOT}/server/sumo"
fi
mkdir -p "${ROOT}/server"
cp -f "${LSP_BINARY}"    "${LSP_DEST}"
cp -f "${KERNEL_BINARY}" "${KERNEL_DEST}"
chmod +x "${LSP_DEST}" "${KERNEL_DEST}" 2>/dev/null || true  # best-effort on Windows hosts

echo "[package-platform] staged ${LSP_BINARY}    -> ${LSP_DEST}"
echo "[package-platform] staged ${KERNEL_BINARY} -> ${KERNEL_DEST}"
echo "[package-platform] target = ${VSCE_TARGET}"

cd "${ROOT}"

# Ensure dependencies + compiled output are present.  `npm ci` is
# preferred in CI for a clean lockfile-derived install; fall back
# to `npm install` when no lockfile is present (first-time dev).
if [[ -f "package-lock.json" ]]; then
    npm ci
else
    npm install
fi
npm run compile

# Package the VSIX for the resolved platform.  vsce walks
# `node_modules/` against `.vscodeignore` to include runtime
# deps (vscode-languageclient + transitive crates); using
# `--no-dependencies` here breaks that pruning and ships an
# extension missing its runtime -- don't use it.
npx --no vsce package --target "${VSCE_TARGET}"

echo "[package-platform] done -- VSIX in ${ROOT}/"
ls -lh "${ROOT}"/*.vsix 2>/dev/null || true
