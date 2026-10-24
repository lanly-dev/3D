"""Minimal Meshes container (pure PyTorch) — see pytorch3d/__init__ note."""
import torch


class Meshes:
    """Stores per-mesh verts/faces lists, like pytorch3d.structures.Meshes.

    Only the surface MeshCoder's eval helpers touch: isempty(),
    faces_areas_packed(), verts_padded(), faces_padded().
    """

    def __init__(self, verts=None, faces=None, **_kwargs):
        self._verts = list(verts) if verts is not None else []
        self._faces = list(faces) if faces is not None else []

    def isempty(self):
        return all(v.shape[0] == 0 or f.shape[0] == 0 for v, f in zip(self._verts, self._faces))

    def verts_list(self):
        return self._verts

    def faces_list(self):
        return self._faces

    def verts_padded(self):
        maxv = max((v.shape[0] for v in self._verts), default=0)
        out = []
        for v in self._verts:
            pad = maxv - v.shape[0]
            out.append(torch.cat([v, v.new_zeros((pad, 3))], dim=0) if pad else v)
        return torch.stack(out, dim=0)

    def faces_padded(self):
        maxf = max((f.shape[0] for f in self._faces), default=0)
        out = []
        for f in self._faces:
            pad = maxf - f.shape[0]
            out.append(torch.cat([f, f.new_full((pad, 3), -1, dtype=f.dtype)], dim=0) if pad else f)
        return torch.stack(out, dim=0)

    def faces_areas_packed(self):
        areas = []
        for v, f in zip(self._verts, self._faces):
            if f.shape[0] == 0:
                areas.append(v.new_zeros((0,)))
                continue
            a = v[f[:, 0]]
            b = v[f[:, 1]]
            c = v[f[:, 2]]
            areas.append(0.5 * torch.linalg.cross(b - a, c - a).norm(dim=1))
        return torch.cat(areas, dim=0) if areas else torch.zeros((0,))
