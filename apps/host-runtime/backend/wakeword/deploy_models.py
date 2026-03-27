#!/usr/bin/env python3
"""
Deploy wakeword models to the oww/ directory.

Handles both external-data models (.onnx + .onnx.data) and models with
already-embedded weights. All output models are self-contained with weights
inline (required for ORT Web URL loading).

Usage:
    python deploy_models.py <source_dir>       Deploy from archive to oww/
    python deploy_models.py archive/v5-2026-03-07
    python deploy_models.py oww                Fix models in-place (re-embed weights, remove .data files)
"""

import os
import shutil
import sys
import tempfile

try:
    import onnx
    from onnx import version_converter
except ImportError:
    print("Error: onnx package required. Install with: pip install onnx")
    sys.exit(1)

# ORT Web v1.14.0 compatibility limits
MAX_OPSET = 18
MAX_IR_VERSION = 8

OWW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "oww")

# Infrastructure models that should never be replaced
SKIP_FILES = {"melspectrogram.onnx", "embedding_model.onnx", "silero_vad.onnx", "speaker_verification.onnx"}


def _has_external_data(model) -> bool:
    """Check if any initializer references external data."""
    return any(init.data_location == 1 or init.external_data for init in model.graph.initializer)


def _embed_and_downgrade(src_path: str) -> tuple:
    """Load a model, embed external weights, downgrade opset if needed.

    Returns (model, had_external, src_opset, final_opset).
    Works for both external-data and already-embedded models.
    """
    # Try loading with external data resolved from source directory
    try:
        model = onnx.load(src_path, load_external_data=True)
    except Exception:
        # Fallback: load graph only, then try to load external data manually
        model = onnx.load(src_path, load_external_data=False)
        src_dir = os.path.dirname(os.path.abspath(src_path))
        try:
            onnx.load_external_data_for_model(model, src_dir)
        except Exception as e:
            print(f"  WARNING: could not load external data for {os.path.basename(src_path)}: {e}")
            print("           model may have incomplete weights")

    had_external = _has_external_data(model)

    # Embed all external weights inline
    for init in model.graph.initializer:
        if init.external_data:
            init.external_data[:] = []
            init.data_location = 0  # ONNX DEFAULT = inline

    # Downgrade opset and IR version for ORT Web compatibility
    src_opset = max((o.version for o in model.opset_import), default=0)
    if src_opset > MAX_OPSET:
        model = version_converter.convert_version(model, MAX_OPSET)
    if model.ir_version > MAX_IR_VERSION:
        model.ir_version = MAX_IR_VERSION

    final_opset = max((o.version for o in model.opset_import), default=0)
    return model, had_external, src_opset, final_opset


def deploy(source_dir: str) -> None:
    if not os.path.isdir(source_dir):
        print(f"Error: {source_dir} is not a directory")
        sys.exit(1)

    source_dir = os.path.abspath(source_dir)
    in_place = os.path.abspath(OWW_DIR) == source_dir

    onnx_files = [f for f in os.listdir(source_dir) if f.endswith(".onnx") and f not in SKIP_FILES]

    if not onnx_files:
        print(f"No .onnx keyword model files found in {source_dir}")
        sys.exit(1)

    deployed = 0
    skipped = 0
    for onnx_file in sorted(onnx_files):
        keyword = onnx_file.replace(".onnx", "")
        src_onnx = os.path.join(source_dir, onnx_file)
        dst_onnx = os.path.join(OWW_DIR, f"{keyword}.onnx")
        data_file = os.path.join(OWW_DIR, f"{keyword}.onnx.data")
        # Also check source dir for .data files (in-place mode)
        src_data_file = os.path.join(source_dir, f"{keyword}.onnx.data")

        # Quick check: if in-place and no .data file exists, peek at model
        if in_place and not os.path.exists(src_data_file):
            try:
                model_peek = onnx.load(src_onnx, load_external_data=False)
                if not _has_external_data(model_peek):
                    skipped += 1
                    continue
            except Exception:
                pass  # proceed with full load to surface the error

        model, had_external, src_opset, final_opset = _embed_and_downgrade(src_onnx)

        # For in-place mode, write to temp file first then rename
        if in_place:
            fd, tmp_path = tempfile.mkstemp(suffix=".onnx", dir=OWW_DIR)
            os.close(fd)
            try:
                onnx.save(model, tmp_path)
                os.replace(tmp_path, dst_onnx)
            except Exception:
                os.unlink(tmp_path)
                raise
        else:
            onnx.save(model, dst_onnx)

        size = os.path.getsize(dst_onnx)
        notes = []
        if had_external:
            notes.append("external→embedded")
        if src_opset > MAX_OPSET:
            notes.append(f"opset {src_opset}→{final_opset}")
        extra = f" ({', '.join(notes)})" if notes else ""
        print(f"  {keyword}: deployed ({size} bytes{extra})")
        deployed += 1

        # Remove orphaned .data files
        for df in (data_file, src_data_file):
            if os.path.exists(df):
                os.remove(df)
                print(f"    removed orphaned {os.path.basename(df)}")

        # Copy .json config if present (skip for in-place, already there)
        if not in_place:
            src_json = os.path.join(source_dir, f"{keyword}.json")
            if os.path.exists(src_json):
                shutil.copy2(src_json, os.path.join(OWW_DIR, f"{keyword}.json"))

    if skipped:
        print(f"  ({skipped} models already have embedded weights, skipped)")
    if deployed == 0 and skipped > 0:
        print("All models already OK — nothing to do.")


def main():
    if len(sys.argv) != 2:
        print(__doc__.strip())
        sys.exit(1)

    source_dir = sys.argv[1]
    in_place = os.path.abspath(source_dir) == os.path.abspath(OWW_DIR)
    if in_place:
        print(f"Fixing models in-place in {OWW_DIR}")
    else:
        print(f"Deploying models from {source_dir} → {OWW_DIR}")
    deploy(source_dir)
    print("Done. Refresh the browser to load new models.")


if __name__ == "__main__":
    main()
