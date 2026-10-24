"""Pure-PyTorch chamfer_distance with pytorch3d's semantics.

Only what MeshCoder needs: llama_recipes' train_utils_shape2code imports
chamfer_distance at module level; the inference path never calls it (it is
used for training-time validation loss). This implementation is correct
(L2 distances, masked by lengths, mean/sum reductions), just slower than
pytorch3d's CUDA kernel.
"""
import torch


def chamfer_distance(x, y, x_lengths=None, y_lengths=None, x_normals=None,
                     y_normals=None, weights=None, batch_reduction="mean",
                     point_reduction="mean", **_kwargs):
    if x.dim() != 3 or y.dim() != 3:
        raise ValueError("x and y must be batched point clouds (N, P, D)")
    n, p1, _ = x.shape
    _, p2, _ = y.shape
    device = x.device
    if x_lengths is None:
        x_lengths = torch.full((n,), p1, dtype=torch.int64, device=device)
    if y_lengths is None:
        y_lengths = torch.full((n,), p2, dtype=torch.int64, device=device)
    dists = torch.cdist(x, y)
    valid_x = torch.arange(p1, device=device).view(1, p1) < x_lengths.view(n, 1)
    valid_y = torch.arange(p2, device=device).view(1, p2) < y_lengths.view(n, 1)
    pair_valid = valid_x.unsqueeze(2) & valid_y.unsqueeze(1)
    masked = torch.where(pair_valid, dists, torch.full_like(dists, 1e18))
    min_x, nn_x = masked.min(dim=2)
    min_y, nn_y = masked.min(dim=1)
    min_x = torch.where(valid_x & (y_lengths.view(n, 1) > 0), min_x, torch.zeros_like(min_x))
    min_y = torch.where(valid_y & (x_lengths.view(n, 1) > 0), min_y, torch.zeros_like(min_y))

    def reduce_points(vals, valid):
        if point_reduction == "mean":
            denom = valid.sum(dim=1).clamp(min=1).to(vals.dtype)
            return (vals * valid.to(vals.dtype)).sum(dim=1) / denom
        if point_reduction == "sum":
            return (vals * valid.to(vals.dtype)).sum(dim=1)
        raise ValueError(f"unknown point_reduction: {point_reduction}")

    loss = reduce_points(min_x, valid_x) + reduce_points(min_y, valid_y)
    if weights is not None:
        loss = loss * weights
    if x_normals is not None and y_normals is not None:
        nn_y = torch.gather(y_normals, 1, nn_x.unsqueeze(-1).expand(-1, -1, y_normals.shape[-1]))
        nn_xn = torch.gather(x_normals, 1, nn_y.unsqueeze(-1).expand(-1, -1, x_normals.shape[-1]))
        loss_normals = reduce_points(1.0 - (x_normals * nn_y).sum(-1).abs(), valid_x) \
            + reduce_points(1.0 - (y_normals * nn_xn).sum(-1).abs(), valid_y)
        if weights is not None:
            loss_normals = loss_normals * weights
    else:
        loss_normals = torch.zeros_like(loss)

    def reduce_batch(v):
        if batch_reduction is None:
            return v
        if batch_reduction == "mean":
            return v.mean()
        if batch_reduction == "sum":
            return v.sum()
        raise ValueError(f"unknown batch_reduction: {batch_reduction}")

    return reduce_batch(loss), reduce_batch(loss_normals)
