# Minimal pure-PyTorch stand-in for the parts of pytorch3d that
# MeshCoder's import chain touches (pytorch3d.loss, pytorch3d.ops,
# pytorch3d.structures). Written by the Hunyuan3D app because pytorch3d
# has no Windows builds; the functions are real implementations, just
# slower than pytorch3d's CUDA kernels.
from . import loss, ops, structures  # noqa: F401

__all__ = ["loss", "ops", "structures"]
