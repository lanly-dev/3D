"""Pure-PyTorch sample_points_from_meshes — see pytorch3d/__init__ note."""
import torch


def sample_points_from_meshes(meshes, num_samples=5000, return_normals=False,
                              return_textures=False, **_kwargs):
    if return_textures:
        raise NotImplementedError("shim: textures are not supported")
    all_points = []
    all_normals = []
    for verts, faces in zip(meshes.verts_list(), meshes.faces_list()):
        a = verts[faces[:, 0]]
        b = verts[faces[:, 1]]
        c = verts[faces[:, 2]]
        areas = 0.5 * torch.linalg.cross(b - a, c - a).norm(dim=1)
        total = areas.sum()
        if total <= 0:
            pts = verts.new_zeros((num_samples, 3))
            nrm = verts.new_zeros((num_samples, 3))
        else:
            face_idx = torch.multinomial(areas / total, num_samples, replacement=True)
            r1 = torch.rand(num_samples, 1, device=verts.device, dtype=verts.dtype)
            r2 = torch.rand(num_samples, 1, device=verts.device, dtype=verts.dtype)
            sqrt_r1 = r1.sqrt()
            u = 1.0 - sqrt_r1
            v = sqrt_r1 * (1.0 - r2)
            w = sqrt_r1 * r2
            pts = u * a[face_idx] + v * b[face_idx] + w * c[face_idx]
            n = torch.linalg.cross(b[face_idx] - a[face_idx], c[face_idx] - a[face_idx])
            nrm = n / n.norm(dim=1, keepdim=True).clamp(min=1e-12)
        all_points.append(pts)
        all_normals.append(nrm)
    points = torch.stack(all_points, dim=0)
    if return_normals:
        return points, torch.stack(all_normals, dim=0)
    return points
