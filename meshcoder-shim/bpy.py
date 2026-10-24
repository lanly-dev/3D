"""Stand-in for Blender's `bpy` module (installed by the Hunyuan3D app).

Why this exists: MeshCoder's inference chain imports
llama_recipes.blender_scripts.code_to_mesh, which does `import bpy` at
module level, and bpy 4.0.0 was never published to PyPI — there is no
real bpy to install for this env's Python 3.10 on Windows.

What inference actually does with bpy: `shape_to_text` generates the
Blender code first, then — because the inference script hardcodes
eval_reconstruction_performance=True — calls batch_code_to_mesh to
score the result. That evaluation cannot run on native Windows at all:
batch_code_to_mesh wraps each execution in a SIGALRM time limit
(Unix-only), so every generated script "fails" evaluation before any
Blender code runs, and the failure handler then calls
bpy.ops.wm.read_homefile() to reset Blender for the next script. With
no real Blender behind it, that reset is the one bpy call that must not
raise — otherwise it escapes the per-script error handling and kills
the whole conversion after the code was already generated.

So: every `bpy.ops.*` call is a no-op returning {'FINISHED'} (scene
resets and other operators have nothing to act on), evaluation reports
success=0 for every script, and the inference caller still receives
the generated code and saves it — only the reconstruction metrics
(Chamfer distance) are skipped. Anything outside bpy.ops (bpy.data,
bpy.context, ...) still raises, so a code path that genuinely needs
Blender state fails loudly instead of silently producing wrong data.
"""


class _OpsNode:
    """A bpy.ops stand-in: any attribute chain is callable as a no-op."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _OpsNode()

    def __call__(self, *args, **kwargs):
        return {"FINISHED"}


ops = _OpsNode()


def __getattr__(name):
    raise RuntimeError(
        "bpy is not available in this env (stand-in installed by the "
        "Hunyuan3D app). Only bpy.ops.* calls are bridged (as no-ops, "
        "for MeshCoder's reconstruction-evaluation reset); this code "
        "path needs real Blender state."
    )
