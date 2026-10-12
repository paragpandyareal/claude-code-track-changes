#!/usr/bin/env python3
# Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
# Claude Code Track Changes: https://github.com/paragpandyareal/claude-code-track-changes
# Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel
"""Writes one file from base64: python3 -I write_file.py <base64 file> <target>.

Used by Claude Code Track Changes on Linux computers without openssl, only when the
person presses Restore or Keep this version. Standard library only. The
target is written to a temporary file beside it, then put in place, so a
half-written file never replaces a good one.
"""
import base64
import os
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: write_file.py <base64 file> <target>", file=sys.stderr)
        return 2
    source, target = sys.argv[1], sys.argv[2]
    with open(source, "rb") as handle:
        data = base64.b64decode(handle.read(), validate=False)
    temp = f"{target}.track-changes-{os.getpid()}"
    with open(temp, "xb") as handle:
        handle.write(data)
    os.replace(temp, target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
