"""Import-only stub for Blender's `bpy` module.

llama_recipes.blender_scripts.code_to_mesh does `import bpy` at module
level, and MeshCoder's inference chain imports that module — but the
functions that actually use bpy belong to the training-time evaluation
path (executing generated code inside Blender), which inference never
calls (and which could not run on Windows anyway: it relies on
signal.SIGALRM). Any real use of this stub raises a clear error.
"""


def __getattr__(name):
    raise RuntimeError(
        "bpy is not available in this env (import-only stub installed by "
        "the Hunyuan3D app). The code path that needs Blender's bpy is "
        "MeshCoder's training-time evaluation, not inference."
    )
