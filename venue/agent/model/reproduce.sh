#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${LATTICE_MODEL_TRAINING_VENV:-${MODEL_DIR}/.venv}"
PYTHON="${PYTHON:-python3}"
export PYTHONDONTWRITEBYTECODE=1

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  "${PYTHON}" -m venv "${VENV_DIR}"
fi

"${VENV_DIR}/bin/python" -m pip install \
  --disable-pip-version-check \
  --requirement "${MODEL_DIR}/requirements-training.txt"

exec "${VENV_DIR}/bin/python" "${MODEL_DIR}/train.py" \
  --config "${MODEL_DIR}/training_config.json" \
  --output-dir "${MODEL_DIR}"
