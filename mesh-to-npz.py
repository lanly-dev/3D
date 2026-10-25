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


def face_groups(mesh, face_mask=None):
    """Group face indices into connected components of the
    face-adjacency graph (optionally only over faces where
    face_mask is true). Pure numpy union-find — trimesh.split()
    needs a graph engine (networkx/scipy) that is not guaranteed
    to exist. Returns a list of index arrays, or None when the
    grouping is meaningless (no adjacency / unwelded soup)."""
    faces = getattr(mesh, "faces", None)
    if faces is None or len(faces) == 0:
        return None
    adj = getattr(mesh, "face_adjacency", None)
    if adj is None or len(adj) == 0:
        return None
    parent = list(range(len(faces)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in adj:
        a, b = int(a), int(b)
        if face_mask is not None and not (face_mask[a] and face_mask[b]):
            continue
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    groups = {}
    for i in range(len(faces)):
        if face_mask is not None and not face_mask[i]:
            continue
        groups.setdefault(find(i), []).append(i)
    if len(groups) > 500:
        return None
    return [np.asarray(v) for v in groups.values()]


def mesh_shells(mesh):
    """Connected components of the face-adjacency graph (shells),
    largest first."""
    try:
        mesh.merge_vertices()
    except Exception:
        pass
    groups = face_groups(mesh)
    if groups is None:
        return [mesh]
    shells = []
    for idxs in groups:
        try:
            sub = mesh.submesh([idxs], append=True)
        except Exception:
            return [mesh]
        if sub is not None and getattr(sub, "area", 0) > 0:
            shells.append(sub)
    return shells or [mesh]


def vertex_normals_np(mesh):
    """Area-weighted vertex normals in plain numpy (trimesh's own
    path wants scipy, which is not guaranteed to exist)."""
    fn = np.asarray(mesh.face_normals, dtype=np.float64)
    fa = np.asarray(mesh.area_faces, dtype=np.float64)
    faces = np.asarray(mesh.faces)
    vn = np.zeros((len(mesh.vertices), 3))
    w = fn * fa[:, None]
    np.add.at(vn, faces[:, 0], w)
    np.add.at(vn, faces[:, 1], w)
    np.add.at(vn, faces[:, 2], w)
    norms = np.linalg.norm(vn, axis=1, keepdims=True)
    return vn / np.where(norms == 0, 1.0, norms)


def ray_thickness(mesh, origins, dirs):
    """Nearest positive ray/triangle distance per ray (nan when a
    ray hits nothing). Möller–Trumbore in chunked numpy — trimesh's
    intersector wants rtree, which is not guaranteed to exist."""
    tris = np.asarray(mesh.triangles, dtype=np.float64)
    best = np.full(len(origins), np.inf)
    for ts in range(0, len(tris), 8192):
        t = tris[ts : ts + 2048]
        e1 = t[:, 1] - t[:, 0]
        e2 = t[:, 2] - t[:, 0]
        for rs in range(0, len(origins), 256):
            o = origins[rs : rs + 256]
            d = dirs[rs : rs + 256]
            pvec = np.cross(d[:, None, :], e2[None, :, :])
            det = (e1[None, :, :] * pvec).sum(-1)
            ok = np.abs(det) > 1e-9
            inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
            tvec = o[:, None, :] - t[None, :, 0]
            u = (tvec * pvec).sum(-1) * inv
            qvec = np.cross(tvec, e1[None, :, :])
            v = (d[:, None, :] * qvec).sum(-1) * inv
            tt = (e2[None, :, :] * qvec).sum(-1) * inv
            hit = ok & (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9) & (tt > 1e-7)
            tt = np.where(hit, tt, np.inf)
            best[rs : rs + 256] = np.minimum(best[rs : rs + 256], tt.min(axis=1))
    return np.where(np.isinf(best), np.nan, best)


def shape_diameter(mesh, max_samples=2000, seed=0):
    """Per-vertex local thickness (SDF-lite): from each sampled
    vertex, cast a ray inward along the negated vertex normal and
    measure the distance to the far side of the shape; propagate
    to the remaining vertices by nearest sampled vertex. Seeded —
    fully deterministic. Misses (open geometry, corner normals)
    fall back to the median measured thickness."""
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    normals = vertex_normals_np(mesh)
    n = len(verts)
    diag = float(np.linalg.norm(mesh.extents)) or 1.0
    rng = np.random.default_rng(seed)
    if n <= max_samples:
        idx = np.arange(n)
    else:
        idx = np.sort(rng.choice(n, max_samples, replace=False))
    origins = verts[idx] - normals[idx] * (diag * 1e-4)
    thick = ray_thickness(mesh, origins, -normals[idx])
    finite = np.isfinite(thick)
    fill = float(np.median(thick[finite])) if finite.any() else diag
    thick = np.where(finite, thick, fill)
    full = np.empty(n)
    full[idx] = thick
    rest = np.setdiff1d(np.arange(n), idx)
    sample_pts = verts[idx]
    for s in range(0, len(rest), 2048):
        r = rest[s : s + 2048]
        d2 = ((verts[r][:, None, :] - sample_pts[None, :, :]) ** 2).sum(-1)
        full[r] = thick[d2.argmin(1)]
    return full


def neck_split(mesh, min_area_frac=0.01):
    """Cut a single welded shell into parts at its necks, or return
    None. Thick regions (per shape_diameter) separated by thin
    junctions are the parts: threshold the per-face thickness,
    take the connected components of what survives as seeds, then
    regrow every face into its nearest seed by BFS over the face
    graph, so borders land mid-neck and no face is dropped.
    Deterministic threshold ladder; anything ambiguous (no necks,
    too many fragments) returns None and the mesh converts whole."""
    faces = np.asarray(mesh.faces)
    if len(faces) == 0:
        return None
    face_area = np.asarray(mesh.area_faces, dtype=np.float64)
    total_area = float(face_area.sum()) or 1.0
    sdf_v = shape_diameter(mesh)
    face_t = sdf_v[faces].mean(1)
    hi = float(np.percentile(face_t, 95))
    if hi <= 0:
        return None
    adj = np.asarray(mesh.face_adjacency)
    neighbors = {}
    for a, b in adj:
        neighbors.setdefault(int(a), []).append(int(b))
        neighbors.setdefault(int(b), []).append(int(a))
    from collections import deque

    for tau_frac in (0.35, 0.45, 0.55):
        keep = face_t > tau_frac * hi
        if keep.sum() < 0.2 * len(faces):
            continue
        groups = face_groups(mesh, keep)
        if groups is None:
            continue
        seeds = [g for g in groups if face_area[g].sum() >= min_area_frac * total_area]
        if not (2 <= len(seeds) <= 16):
            continue
        # Multi-source BFS regrow: every face joins its nearest seed.
        assign = np.full(len(faces), -1, dtype=np.int64)
        queue = deque()
        for k, g in enumerate(seeds):
            for f in g:
                assign[f] = k
                queue.append(int(f))
        while queue:
            f = queue.popleft()
            for nb in neighbors.get(f, ()):
                if assign[nb] < 0:
                    assign[nb] = assign[f]
                    queue.append(nb)
        if (assign < 0).any():
            continue
        parts = []
        ok = True
        for k in range(len(seeds)):
            idxs = np.where(assign == k)[0]
            if len(idxs) == 0:
                ok = False
                break
            try:
                sub = mesh.submesh([idxs], append=True)
            except Exception:
                ok = False
                break
            if sub is None or getattr(sub, "area", 0) <= 0:
                ok = False
                break
            parts.append(sub)
        if not ok:
            continue
        parts.sort(key=lambda m: m.area, reverse=True)
        return parts
    return None


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

    # One welded shell: shells can't help, so try cutting at the
    # necks (stage 2). Anything ambiguous converts whole, as before.
    neck = False
    vias = ["shell"] * len(kept)
    if len(shells) == 1 and len(kept) == 1:
        try:
            cut = neck_split(mesh)
        except Exception:
            cut = None
        if cut and len(cut) > 1:
            kept = cut
            neck = True
            vias = ["neck"] * len(kept)
            dropped_area = 0.0  # regrow assigns every face to a part
            print(f"neck split: one welded shell cut into {len(kept)} parts at its thin junctions")

    os.makedirs(args.output, exist_ok=True)
    parts = []
    for i, shell in enumerate(kept):
        points, face_idx = sample_surface(shell, args.samples)
        points = np.asarray(points, dtype=np.float64)
        normals = shell.face_normals[face_idx]
        points = (points - center) / extent  # global frame, within [-1, 1]
        fname = f"part-{i + 1}.npz"
        write_npz(os.path.join(args.output, fname), points, normals)
        parts.append(
            {"file": fname, "areaFraction": round(float(shell.area / total_area), 4), "via": vias[i]}
        )
    manifest = {
        "parts": parts,
        "shellsFound": len(shells),
        "shellsKept": len(kept),
        "neckSplit": neck,
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
