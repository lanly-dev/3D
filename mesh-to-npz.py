#!/usr/bin/env python3
"""Convert a mesh file (GLB/OBJ/PLY/STL) into the NPZ point-cloud format
MeshCoder expects: keys 'points' and 'normals', each shaped (1, N, 3) —
a batch of one point cloud, normalized to [-1, 1]. The leading axis
matters: llama_recipes' GeneralNpzDataset treats axis 0 as the sample
axis, so an unbatched (N, 3) array reads as N one-point "shapes" and
inference dies concatenating features along a missing dimension.

Usage:
    python mesh-to-npz.py input.glb output.npz [--samples 16384]

Requires: trimesh, numpy (both already in the MeshCoder env).
"""
import argparse
import sys

import numpy as np


def load_geometry(path):
    import trimesh
    from trimesh.sample import sample_surface

    loaded = trimesh.load(path, force="scene")
    if isinstance(loaded, trimesh.Scene):
        # to_geometry() on newer trimesh, dump(concatenate=True) on older
        geom = (
            loaded.to_geometry()
            if hasattr(loaded, "to_geometry")
            else loaded.dump(concatenate=True)
        )
    else:
        geom = loaded
    if not isinstance(geom, trimesh.Trimesh):
        raise TypeError(f"could not extract a mesh from {path!r}")
    return geom, sample_surface


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--samples", type=int, default=16384)
    args = ap.parse_args()

    mesh, sample_surface = load_geometry(args.input)
    points, face_idx = sample_surface(mesh, args.samples)
    normals = mesh.face_normals[face_idx]

    points = np.asarray(points, dtype=np.float64)
    center = (points.max(axis=0) + points.min(axis=0)) / 2.0
    points -= center
    extent = np.abs(points).max()
    if extent == 0:
        print("degenerate mesh: zero extent", file=sys.stderr)
        return 1
    points /= extent  # now within [-1, 1]

    # Batch of one: (1, N, 3). See the module docstring — the dataset
    # loader indexes axis 0 per shape.
    np.savez(
        args.output,
        points=points.astype(np.float32)[None, :, :],
        normals=np.asarray(normals, dtype=np.float32)[None, :, :],
    )
    print(f"wrote {args.output}: {len(points)} points")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
