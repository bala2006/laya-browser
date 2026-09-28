#!/usr/bin/env bash
# prepare-model.sh - build a @receptron/laya-loadable ONNX bundle for laya-browser-mcp.
#
# Produces a local ONNX bundle directory you can point LAYA_MODEL_DIR at. NOTHING it
# produces is committed: weights are large and .gitignore excludes *.onnx / *.onnx.data /
# model/ / .venv / .cache. Run it in a SCRATCH dir outside the tracked source.
#
# Three modes are supported (pick with the first argument):
#
#   reference   convaiinnovations/laya - the reference System-1 decision model. SIMPLEST:
#               @receptron/laya downloads a ready-made ONNX bundle (repo receptron/laya-onnx),
#               so no Python/export is needed. Loads directly via Laya.load({ modelDir }).
#
#   web-agent   abedinia/laya-web-agent - the web-navigation checkpoint. Needs a Python 3.12
#               export (torch/transformers -> ONNX) plus a one-line tokenizer special-token
#               rename (<bos>/<eos>/<mask>/<pad> -> [CLS]/[SEP]/[MASK]/[PAD], SAME token IDs)
#               because @receptron/laya@0.1.2 hardcodes the ModernBERT special-token names.
#
#   int8        Build the web-agent fp32 bundle (as above) and then produce a SIBLING int8
#               bundle by running onnxruntime dynamic quantization over laya.onnx
#               (QuantType.QInt8). The tokenizer/ and laya_config.json are copied UNCHANGED so
#               the int8 directory is a drop-in LAYA_MODEL_DIR. Reuses the same uv Python venv.
#
# Usage:
#   scripts/prepare-model.sh reference [OUT_DIR]     # default OUT_DIR: ./.cache/laya-work
#   scripts/prepare-model.sh web-agent [OUT_DIR]
#   scripts/prepare-model.sh int8 [OUT_DIR]          # fp32 bundle + sibling int8 bundle
#
# Requirements: node + this repo's node_modules (pnpm install), and for web-agent/int8: `uv`
# (Python 3.12) and network access to Hugging Face + GitHub.
#
# Measured on this environment (CPU): reference bundle ~1.69 GB, per-decide (2 narrow choice
# questions) ~810-870 ms; web-agent bundle laya.onnx ~1291 MB, per-decide ~440-490 ms. See
# docs/PLAN.md for the head-to-head decision-quality notes.
set -euo pipefail

MODEL="${1:-reference}"
OUT_DIR="${2:-$(cd "$(dirname "$0")/.." && pwd)/.cache/laya-work}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT_DIR"

# build_web_agent_fp32 <work_dir>
# Set up the uv Python 3.12 venv, export abedinia/laya-web-agent to ONNX, and apply the
# one-line tokenizer special-token rename. Leaves the fp32 bundle at <work_dir>/webagent-onnx
# and the venv at <work_dir>/.venv (reused by the int8 mode for quantization).
build_web_agent_fp32() {
  local WORK="$1"
  echo "==> web-agent: setting up Python 3.12 venv in $WORK/.venv"
  uv venv -p 3.12 "$WORK/.venv"
  uv pip install -p "$WORK/.venv/bin/python" \
    torch transformers safetensors onnx onnxscript onnxruntime huggingface_hub

  echo "==> fetching export_onnx.py from receptron/laya"
  if command -v gh >/dev/null 2>&1; then
    gh api repos/receptron/laya/contents/export/export_onnx.py --jq '.content' | base64 -d > "$WORK/export_onnx.py"
  else
    curl -fsSL "https://raw.githubusercontent.com/receptron/laya/main/export/export_onnx.py" -o "$WORK/export_onnx.py"
  fi

  echo "==> downloading abedinia/laya-web-agent + reference model modules"
  "$WORK/.venv/bin/python" - "$WORK" <<'PY'
import os, sys
from huggingface_hub import snapshot_download
work = sys.argv[1]
model_dir = os.path.join(work, "webagent-model")
snapshot_download("abedinia/laya-web-agent", local_dir=model_dir,
                  allow_patterns=["model.safetensors","encoder/*","tokenizer/*","rl_agent_config.json"])
snapshot_download("convaiinnovations/laya", local_dir=model_dir,
                  allow_patterns=["rl_common.py","rl_agent_api.py","email_utils.py"])
print("downloaded to", model_dir)
PY

  echo "==> exporting to ONNX ($WORK/webagent-onnx)"
  (cd "$WORK" && "$WORK/.venv/bin/python" export_onnx.py webagent-model webagent-onnx)

  echo "==> renaming tokenizer special tokens (<bos>/<eos>/<mask>/<pad> -> [CLS]/[SEP]/[MASK]/[PAD], same IDs)"
  "$WORK/.venv/bin/python" - "$WORK/webagent-onnx" <<'PY'
import json, os, sys
onnx_dir = sys.argv[1]
RENAME = {"<bos>": "[CLS]", "<eos>": "[SEP]", "<mask>": "[MASK]", "<pad>": "[PAD]"}
tj_path = os.path.join(onnx_dir, "tokenizer", "tokenizer.json")
tj = json.load(open(tj_path))
for a in tj.get("added_tokens", []):
    if a["content"] in RENAME:
        a["content"] = RENAME[a["content"]]
vocab = tj.get("model", {}).get("vocab")
if isinstance(vocab, dict):
    for old, new in RENAME.items():
        if old in vocab:
            vocab[new] = vocab.pop(old)
json.dump(tj, open(tj_path, "w"), ensure_ascii=False)
tc_path = os.path.join(onnx_dir, "tokenizer", "tokenizer_config.json")
tc = json.load(open(tc_path))
for _id, entry in tc.get("added_tokens_decoder", {}).items():
    if isinstance(entry, dict) and entry.get("content") in RENAME:
        entry["content"] = RENAME[entry["content"]]
for key, val in list(tc.items()):
    if isinstance(val, str) and val in RENAME:
        tc[key] = RENAME[val]
    elif isinstance(val, dict) and val.get("content") in RENAME:
        val["content"] = RENAME[val["content"]]
json.dump(tc, open(tc_path, "w"), ensure_ascii=False, indent=1)
print("renamed special tokens in", tj_path)
PY
}

case "$MODEL" in
  reference)
    echo "==> reference: downloading receptron/laya-onnx via @receptron/laya into $OUT_DIR/cache"
    node --input-type=module -e "
      import { Laya } from '${REPO_ROOT}/node_modules/@receptron/laya/dist/index.js';
      const laya = await Laya.load({ cacheDir: '${OUT_DIR}/cache' });
      await laya.close();
      console.log('OK: reference bundle ready under ${OUT_DIR}/cache/receptron--laya-onnx/main');
    "
    echo "==> LAYA_MODEL_DIR=${OUT_DIR}/cache/receptron--laya-onnx/main"
    ;;

  web-agent)
    build_web_agent_fp32 "$OUT_DIR"
    echo "==> LAYA_MODEL_DIR=${OUT_DIR}/webagent-onnx"
    ;;

  int8)
    WORK="$OUT_DIR"
    build_web_agent_fp32 "$WORK"
    FP32_DIR="$WORK/webagent-onnx"
    INT8_DIR="$WORK/webagent-onnx-int8"
    echo "==> int8: dynamic-quantizing $FP32_DIR/laya.onnx into $INT8_DIR (QuantType.QInt8)"
    mkdir -p "$INT8_DIR/tokenizer"
    "$WORK/.venv/bin/python" - "$FP32_DIR" "$INT8_DIR" <<'PY'
import shutil, sys
from pathlib import Path
from onnxruntime.quantization import quantize_dynamic, QuantType

fp32_dir = Path(sys.argv[1])
int8_dir = Path(sys.argv[2])
int8_dir.mkdir(parents=True, exist_ok=True)

# Dynamic quantization: weights become int8, activations stay float and are quantized on the
# fly at run time. No calibration data is needed, which is why this suits a drop-in speed lever.
quantize_dynamic(
    model_input=str(fp32_dir / "laya.onnx"),
    model_output=str(int8_dir / "laya.onnx"),
    weight_type=QuantType.QInt8,
)

# Copy the tokenizer and config UNCHANGED so the int8 dir is a drop-in LAYA_MODEL_DIR.
shutil.copy2(fp32_dir / "laya_config.json", int8_dir / "laya_config.json")
tok_src = fp32_dir / "tokenizer"
tok_dst = int8_dir / "tokenizer"
if tok_dst.exists():
    shutil.rmtree(tok_dst)
shutil.copytree(tok_src, tok_dst)
print("int8 bundle written to", int8_dir)
PY
    echo "==> LAYA_MODEL_DIR (fp32) =${FP32_DIR}"
    echo "==> LAYA_MODEL_DIR (int8) =${INT8_DIR}"
    ;;

  *)
    echo "unknown model '$MODEL' (expected: reference | web-agent | int8)" >&2
    exit 2
    ;;
esac

echo
echo "Done. Point the product at the bundle with:"
echo "  LAYA_MODEL_DIR=<printed dir> pnpm test    # runs the gated real-weights tests"
echo "  LAYA_MODEL_DIR=<printed dir> pnpm run bench"
echo
echo "REMEMBER: never commit the produced weights (.gitignore already excludes them)."
