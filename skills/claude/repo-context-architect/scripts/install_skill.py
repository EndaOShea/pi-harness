#!/usr/bin/env python3
"""Install this skill for multiple coding CLIs by copying from one source."""
from __future__ import annotations
import argparse
import shutil
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scope", choices=["user", "repo"], default="user")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    source = Path(__file__).resolve().parent.parent
    if args.scope == "user":
        roots = [Path.home() / ".agents/skills", Path.home() / ".claude/skills"]
    else:
        repo = Path(args.repo).resolve()
        roots = [repo / ".agents/skills", repo / ".claude/skills"]

    for root in roots:
        destination = root / source.name
        root.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if not args.force:
                print(f"skip existing: {destination}")
                continue
            shutil.rmtree(destination)
        shutil.copytree(source, destination, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        print(f"installed: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
