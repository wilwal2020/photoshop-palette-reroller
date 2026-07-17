#!/usr/bin/env python3
"""Package src/ into PaletteReroller.ccx (a plain zip Photoshop can install).

Usage:  python build.py
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
OUT = os.path.join(HERE, "PaletteReroller.ccx")


def main():
    files = []
    for root, _dirs, names in os.walk(SRC):
        for n in names:
            full = os.path.join(root, n)
            # zip path relative to src/, forward slashes for cross-platform
            rel = os.path.relpath(full, SRC).replace(os.sep, "/")
            files.append((full, rel))
    files.sort(key=lambda p: p[1])

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for full, rel in files:
            z.write(full, rel)

    print(f"Built {os.path.basename(OUT)} from {len(files)} files in src/")
    for _full, rel in files:
        print(f"  + {rel}")


if __name__ == "__main__":
    main()
