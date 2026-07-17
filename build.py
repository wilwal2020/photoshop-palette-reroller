#!/usr/bin/env python3
"""Package src/ into PaletteReroller.ccx (a plain zip Photoshop can install).

By default this bumps the patch version in src/manifest.json (e.g. 1.6.1 -> 1.6.2)
so each build installs as a new version, then keeps README.md in sync.

Usage:
  python build.py            # bump patch version, then build
  python build.py --no-bump  # rebuild without changing the version
  python build.py --minor    # bump minor (1.6.2 -> 1.7.0)
  python build.py --major    # bump major (1.6.2 -> 2.0.0)
"""
import os
import re
import sys
import json
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
OUT = os.path.join(HERE, "PaletteReroller.ccx")
MANIFEST = os.path.join(SRC, "manifest.json")
README = os.path.join(HERE, "README.md")


def bump_version(part):
    with open(MANIFEST, "r", encoding="utf-8") as f:
        text = f.read()
    m = json.loads(text)
    major, minor, patch = (int(x) for x in m["version"].split("."))
    if part == "major":
        major, minor, patch = major + 1, 0, 0
    elif part == "minor":
        minor, patch = minor + 1, 0
    else:
        patch += 1
    new_version = f"{major}.{minor}.{patch}"
    old_version = m["version"]
    # Preserve formatting by replacing just the version string in-place.
    text = re.sub(r'("version"\s*:\s*")[^"]+(")', rf"\g<1>{new_version}\g<2>", text, count=1)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        f.write(text)
    sync_readme(new_version)
    print(f"Bumped version {old_version} -> {new_version}")
    return new_version


def sync_readme(version):
    if not os.path.exists(README):
        return
    with open(README, "r", encoding="utf-8") as f:
        text = f.read()
    new_text = re.sub(r"(\*\*)\d+\.\d+\.\d+(\*\*)", rf"\g<1>{version}\g<2>", text, count=1)
    if new_text != text:
        with open(README, "w", encoding="utf-8") as f:
            f.write(new_text)


def current_version():
    with open(MANIFEST, "r", encoding="utf-8") as f:
        return json.load(f)["version"]


def build():
    files = []
    for root, _dirs, names in os.walk(SRC):
        for n in names:
            full = os.path.join(root, n)
            rel = os.path.relpath(full, SRC).replace(os.sep, "/")
            files.append((full, rel))
    files.sort(key=lambda p: p[1])

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for full, rel in files:
            z.write(full, rel)

    print(f"Built {os.path.basename(OUT)} (v{current_version()}) from {len(files)} files in src/")
    for _full, rel in files:
        print(f"  + {rel}")


def main():
    args = set(sys.argv[1:])
    if "--no-bump" in args:
        pass
    elif "--major" in args:
        bump_version("major")
    elif "--minor" in args:
        bump_version("minor")
    else:
        bump_version("patch")
    build()


if __name__ == "__main__":
    main()
