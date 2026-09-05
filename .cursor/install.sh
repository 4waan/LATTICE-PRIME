#!/usr/bin/env bash
# Idempotent bootstrap for the SeamMe / venue development environment.
#
# Installs the exact toolchain the project pins:
#   - forge 1.5.1        (toolchain/VERIFIED.out; the gas side-channel test in
#                         test/DisclosureMeter.t.sol is version sensitive)
#   - circom 2.2.3       (the circuit compiler the Makefile drives)
#   - node 22.x          (already present via nvm; the Makefile refuses anything else)
#   - toolchain/ deps    (snarkjs, circomlib, circomlibjs, ethers)
#
# Safe to re-run: every step checks before it acts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FORGE_VERSION="1.5.1"
CIRCOM_VERSION="2.2.3"

echo "==> forge-std submodule"
git submodule update --init --recursive

echo "==> Foundry ${FORGE_VERSION}"
export PATH="$PATH:$HOME/.foundry/bin"
if ! command -v forge >/dev/null 2>&1 || ! forge --version 2>/dev/null | grep -q "$FORGE_VERSION"; then
    if ! command -v foundryup >/dev/null 2>&1; then
        curl -L https://foundry.paradigm.xyz | bash
        export PATH="$PATH:$HOME/.foundry/bin"
    fi
    foundryup --install "$FORGE_VERSION"
fi
# Persist the Foundry bin dir for future interactive shells.
if ! grep -q '.foundry/bin' "$HOME/.bashrc" 2>/dev/null; then
    echo 'export PATH="$PATH:$HOME/.foundry/bin"' >>"$HOME/.bashrc"
fi

echo "==> circom ${CIRCOM_VERSION}"
if ! command -v circom >/dev/null 2>&1 || ! circom --version 2>/dev/null | grep -q "$CIRCOM_VERSION"; then
    curl -sL -o /tmp/circom \
        "https://github.com/iden3/circom/releases/download/v${CIRCOM_VERSION}/circom-linux-amd64"
    chmod +x /tmp/circom
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        sudo mv /tmp/circom /usr/local/bin/circom
    else
        mkdir -p "$HOME/.local/bin"
        mv /tmp/circom "$HOME/.local/bin/circom"
        if ! grep -q '.local/bin' "$HOME/.bashrc" 2>/dev/null; then
            echo 'export PATH="$PATH:$HOME/.local/bin"' >>"$HOME/.bashrc"
        fi
    fi
fi

echo "==> Node toolchain (snarkjs, circomlib, circomlibjs, ethers)"
( cd toolchain && npm ci )

# The venue Makefile drives node tools that `import` bare specifiers
# (e.g. circomlibjs). Node's ESM resolver ignores NODE_PATH and only walks
# node_modules directories, so expose the toolchain's modules to venue/.
echo "==> link toolchain node_modules into venue/"
ln -sfn "$REPO_ROOT/toolchain/node_modules" "$REPO_ROOT/venue/node_modules"

echo "==> warm the Solidity build (fetches solc 0.8.24)"
( cd venue && forge build )

echo "==> environment ready"
