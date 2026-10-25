#!/usr/bin/env python3
"""Convert a mesh file (GLB/OBJ/PLY/STL) into the NPZ point-cloud format
MeshCoder expects: keys 'points' and 'normals', each shaped (1, N, 3) —
a batch of one point cloud, normalized to [-1, 1]. The leading axis
matters: llama_recipes' GeneralNpzDataset treats axis 0 as the sample
axis, so an unbatched (N, 3) array reads as N one-point "shapes" and
inference dies concatenating features along a missing dimension.

Usage:
    python mesh-to-npz.py input.glb output.npz [--samples 16384]
    python mesh-to-npz.py input.glb OUTDIR --split [--min-area-frac 0.01]

Split mode writes one NPZ per shell (connected component) plus a
manifest.json. All parts share ONE normalization frame computed from
the whole mesh, so the per-part point clouds stay in their true
relative positions — MeshCoder then generates each part in a short
separate run instead of one long stream for the whole object (long
streams are where its code falls apart: fused calls, truncation).
Shells under --min-area-frac of the total surface are reported as
dropped fragments rather than converted.

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


def write_npz(path, points, normals):
    # Batch of one: (1, N, 3). See the module docstring — the dataset
    # loader indexes axis 0 per shape.
    np.savez(
        path,
        points=np.asarray(points, dtype=np.float32)[None, :, :],
        normals=np.asarray(normals, dtype=np.float32)[None, :, :],
    )


def mesh_shells(mesh):
    """Connected components of the face-adjacency graph (shells),
    largest first. Pure numpy union-find — trimesh.split() needs a
    graph engine (networkx/scipy) that is not guaranteed to exist."""
    try:
        mesh.merge_vertices()
    except Exception:
        pass
    faces = getattr(mesh, "faces", None)
    if faces is None or len(faces) == 0:
        return [mesh]
    adj = getattr(mesh, "face_adjacency", None)
    if adj is None or len(adj) == 0:
        return [mesh]
    parent = list(range(len(faces)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in adj:
        ra, rb = find(int(a)), find(int(b))
        if ra != rb:
            parent[ra] = rb
    groups = {}
    for i in range(len(faces)):
        groups.setdefault(find(i), []).append(i)
    if len(groups) > 500:
        return [mesh]  # unwelded triangle soup — not real shells
    shells = []
    for idxs in groups.values():
        try:
            sub = mesh.submesh([np.asarray(idxs)], append=True)
        except Exception:
            return [mesh]
        if sub is not None and getattr(sub, "area", 0) > 0:
            shells.append(sub)
    return shells or [mesh]


def split_main(args, mesh, sample_surface):
    import json
    import os

    # One global frame for every part, from a whole-mesh sample (the
    # same center/extent math as classic mode).
    frame_points, _ = sample_surface(mesh, args.samples)
    frame_points = np.asarray(frame_points, dtype=np.float64)
    center = (frame_points.max(axis=0) + frame_points.min(axis=0)) / 2.0
    extent = np.abs(frame_points - center).max()
    if extent == 0:
        print("degenerate mesh: zero extent", file=sys.stderr)
        return 1

    shells = mesh_shells(mesh)
    shells.sort(key=lambda m: m.area, reverse=True)
    total_area = float(sum(m.area for m in shells)) or float(mesh.area) or 1.0
    kept_idx = [i for i, m in enumerate(shells) if m.area >= args.min_area_frac * total_area]
    if not kept_idx:
        kept_idx = [0]
    kept = [shells[i] for i in kept_idx]
    dropped_area = total_area - float(sum(m.area for m in kept))

    os.makedirs(args.output, exist_ok=True)
    parts = []
    for i, shell in enumerate(kept):
        points, face_idx = sample_surface(shell, args.samples)
        points = np.asarray(points, dtype=np.float64)
        normals = shell.face_normals[face_idx]
        points = (points - center) / extent  # global frame, within [-1, 1]
        fname = f"part-{i + 1}.npz"
        write_npz(os.path.join(args.output, fname), points, normals)
        parts.append({"file": fname, "areaFraction": round(float(shell.area / total_area), 4)})
    manifest = {
        "parts": parts,
        "shellsFound": len(shells),
        "shellsKept": len(kept),
        "droppedAreaFraction": round(float(dropped_area / total_area), 4),
    }
    with open(os.path.join(args.output, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    print(
        f"split: {len(shells)} shell(s) found, {len(kept)} part(s) to convert, "
        f"fragments dropped: {manifest['droppedAreaFraction']:.1%} of surface"
    )
    for p in parts:
        print(f"  {p['file']}: {p['areaFraction']:.1%} of surface")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--samples", type=int, default=16384)
    ap.add_argument("--split", action="store_true")
    ap.add_argument("--min-area-frac", type=float, default=0.01)
    args = ap.parse_args()

    mesh, sample_surface = load_geometry(args.input)
    if args.split:
        return split_main(args, mesh, sample_surface)
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

    write_npz(args.output, points, normals)
    print(f"wrote {args.output}: {len(points)} points")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
