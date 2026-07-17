# Rebuild PaletteReroller.ccx from src/, bumping the patch version by default.
#   ./build.ps1            bump patch, then build
#   ./build.ps1 --no-bump  rebuild without changing the version
#   ./build.ps1 --minor    bump minor
#   ./build.ps1 --major    bump major
python "$PSScriptRoot\build.py" @args
