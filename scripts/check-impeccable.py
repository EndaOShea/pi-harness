#!/usr/bin/env python3
"""Check Impeccable releases without modifying the vendored skill tree."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
import zipfile


ROOT = Path(__file__).resolve().parents[1]
LOCAL_TREE = ROOT / ".pi" / "skills" / "impeccable"
REPOSITORY_API = "https://api.github.com/repos/pbakaus/impeccable"
USER_AGENT = "pi-harness-impeccable-check/1"
SKILL_TAG = re.compile(r"^skill-v(\d+)\.(\d+)\.(\d+)$")
MAX_METADATA_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_FILES = 10_000


class CheckError(RuntimeError):
    pass


def request_bytes(
    url: str,
    *,
    accept: str = "application/vnd.github+json",
    max_bytes: int = MAX_METADATA_BYTES,
) -> bytes:
    request = Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            content = response.read(max_bytes + 1)
            if len(content) > max_bytes:
                raise CheckError(f"Response exceeded {max_bytes} bytes: {url}")
            return content
    except (HTTPError, URLError, TimeoutError) as exc:
        raise CheckError(f"Unable to read {url}: {exc}") from exc


def request_json(url: str) -> object:
    try:
        return json.loads(request_bytes(url))
    except json.JSONDecodeError as exc:
        raise CheckError(f"GitHub returned invalid JSON for {url}: {exc}") from exc


def skill_version(tree: Path) -> str:
    skill_file = tree / "SKILL.md"
    if not skill_file.is_file():
        raise CheckError(f"Missing SKILL.md in Impeccable tree: {tree}")
    text = skill_file.read_text(encoding="utf-8")
    match = re.search(r"^version:\s*([^\s#]+)\s*$", text, re.MULTILINE)
    if not match:
        raise CheckError(f"Missing version frontmatter in {skill_file}")
    return match.group(1)


def tree_files(tree: Path) -> dict[str, str]:
    if not tree.is_dir():
        raise CheckError(f"Impeccable tree is not a directory: {tree}")
    result = {}
    for path in sorted(item for item in tree.rglob("*") if item.is_file()):
        relative = path.relative_to(tree).as_posix()
        result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    if not result:
        raise CheckError(f"Impeccable tree contains no files: {tree}")
    return result


def tree_hash(tree: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in tree.rglob("*") if item.is_file()):
        digest.update(path.relative_to(tree).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def latest_skill_release() -> dict[str, object]:
    releases = request_json(f"{REPOSITORY_API}/releases?per_page=100")
    if not isinstance(releases, list):
        raise CheckError("GitHub releases response was not an array.")
    candidates = []
    for release in releases:
        if not isinstance(release, dict):
            continue
        tag = release.get("tag_name")
        match = SKILL_TAG.fullmatch(tag) if isinstance(tag, str) else None
        if match and not release.get("draft") and not release.get("prerelease"):
            candidates.append((tuple(map(int, match.groups())), release))
    if not candidates:
        raise CheckError("No stable skill-vX.Y.Z Impeccable release was found.")
    return max(candidates, key=lambda item: item[0])[1]


def release_by_tag(tag: str) -> dict[str, object]:
    if not SKILL_TAG.fullmatch(tag):
        raise CheckError(f"Expected release tag skill-vX.Y.Z, received: {tag}")
    release = request_json(f"{REPOSITORY_API}/releases/tags/{quote(tag, safe='')}")
    if not isinstance(release, dict) or release.get("tag_name") != tag:
        raise CheckError(f"GitHub did not return the expected release: {tag}")
    if release.get("draft") or release.get("prerelease"):
        raise CheckError(f"Refusing draft or prerelease Impeccable release: {tag}")
    return release


def safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    try:
        bundle = zipfile.ZipFile(archive)
    except (OSError, zipfile.BadZipFile) as exc:
        raise CheckError(f"Invalid Impeccable release archive {archive}: {exc}") from exc
    with bundle:
        infos = bundle.infolist()
        if len(infos) > MAX_ARCHIVE_FILES:
            raise CheckError(
                f"Release archive contains more than {MAX_ARCHIVE_FILES} entries."
            )
        extracted_size = sum(info.file_size for info in infos if not info.is_dir())
        if extracted_size > MAX_EXTRACTED_BYTES:
            raise CheckError(
                f"Release archive expands beyond {MAX_EXTRACTED_BYTES} bytes."
            )
        seen = set()
        for info in infos:
            relative = PurePosixPath(info.filename)
            if (
                relative.is_absolute()
                or ".." in relative.parts
                or "\\" in info.filename
                or (relative.parts and ":" in relative.parts[0])
            ):
                raise CheckError(f"Unsafe path in release archive: {info.filename}")
            normalized = relative.as_posix().rstrip("/")
            if normalized in seen:
                raise CheckError(f"Duplicate path in release archive: {info.filename}")
            seen.add(normalized)
            file_type = (info.external_attr >> 16) & 0o170000
            if file_type == 0o120000:
                raise CheckError(f"Symlinks are not accepted in release archives: {info.filename}")
            target = destination.joinpath(*relative.parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(info) as source, target.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)


def locate_pi_tree(root: Path) -> Path:
    if (root / "SKILL.md").is_file():
        return root
    direct = root / ".pi" / "skills" / "impeccable"
    if (direct / "SKILL.md").is_file():
        return direct
    matches = sorted(root.rglob(".pi/skills/impeccable/SKILL.md"))
    if len(matches) != 1:
        raise CheckError(
            f"Expected one .pi/skills/impeccable tree under {root}; found {len(matches)}."
        )
    return matches[0].parent


def staged_archive(archive: Path, staging_parent: Path) -> tuple[Path, Path]:
    staging_root = Path(
        tempfile.mkdtemp(prefix="impeccable-release-", dir=staging_parent)
    )
    extracted = staging_root / "extracted"
    safe_extract(archive, extracted)
    return locate_pi_tree(extracted), staging_root


def download_release(release: dict[str, object], staging_parent: Path) -> tuple[Path, Path]:
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise CheckError("GitHub release contains no asset list.")
    universal = [
        asset
        for asset in assets
        if isinstance(asset, dict) and asset.get("name") == "universal.zip"
    ]
    if len(universal) != 1:
        raise CheckError(
            f"Expected one universal.zip release asset; found {len(universal)}."
        )
    download_url = universal[0].get("browser_download_url")
    if not isinstance(download_url, str) or not download_url.startswith(
        "https://github.com/pbakaus/impeccable/releases/download/"
    ):
        raise CheckError("Release asset has an unexpected download URL.")

    staging_root = Path(
        tempfile.mkdtemp(prefix="impeccable-release-", dir=staging_parent)
    )
    archive = staging_root / "universal.zip"
    archive.write_bytes(
        request_bytes(
            download_url,
            accept="application/octet-stream",
            max_bytes=MAX_ARCHIVE_BYTES,
        )
    )
    extracted = staging_root / "extracted"
    safe_extract(archive, extracted)
    return locate_pi_tree(extracted), staging_root


def compare_trees(candidate: Path, release_tag: str | None) -> int:
    local_version = skill_version(LOCAL_TREE)
    candidate_version = skill_version(candidate)
    if release_tag is not None:
        expected_version = release_tag.removeprefix("skill-v")
        if candidate_version != expected_version:
            raise CheckError(
                f"Candidate version {candidate_version} does not match {release_tag}."
            )

    local_files = tree_files(LOCAL_TREE)
    candidate_files = tree_files(candidate)
    only_local = sorted(local_files.keys() - candidate_files.keys())
    only_candidate = sorted(candidate_files.keys() - local_files.keys())
    changed = sorted(
        name
        for name in local_files.keys() & candidate_files.keys()
        if local_files[name] != candidate_files[name]
    )
    identical = not only_local and not only_candidate and not changed

    print(f"Local version:     {local_version}")
    print(f"Candidate version: {candidate_version}")
    if release_tag:
        print(f"Release tag:       {release_tag}")
    print(f"Local tree hash:     {tree_hash(LOCAL_TREE)}")
    print(f"Candidate tree hash: {tree_hash(candidate)}")
    print(f"Only local files:     {len(only_local)}")
    print(f"Only candidate files: {len(only_candidate)}")
    print(f"Changed files:        {len(changed)}")

    for label, paths in (
        ("Only local", only_local),
        ("Only candidate", only_candidate),
        ("Changed", changed),
    ):
        for path in paths[:50]:
            print(f"  {label}: {path}")
        if len(paths) > 50:
            print(f"  {label}: ... and {len(paths) - 50} more")

    print("Status: identical" if identical else "Status: review required")
    return 0 if identical else 10


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Check or stage an immutable Impeccable skill release without "
            "modifying .pi/skills/impeccable."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "latest", help="Report whether the vendored skill version is current."
    )

    compare = subparsers.add_parser(
        "compare", help="Compare the vendored tree with a staged candidate."
    )
    sources = compare.add_mutually_exclusive_group(required=True)
    sources.add_argument("--candidate-dir", type=Path)
    sources.add_argument("--archive", type=Path)
    sources.add_argument(
        "--download",
        action="store_true",
        help="Download universal.zip for --release, or the latest skill release.",
    )
    compare.add_argument("--release", help="Immutable skill-vX.Y.Z release tag.")
    compare.add_argument(
        "--staging-parent",
        type=Path,
        default=Path("/tmp"),
        help="Existing parent for retained staging directories (default: /tmp).",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    local_version = skill_version(LOCAL_TREE)

    if args.command == "latest":
        release = latest_skill_release()
        tag = str(release["tag_name"])
        latest_version = tag.removeprefix("skill-v")
        print(f"Local version:  {local_version}")
        print(f"Latest release: {tag}")
        if latest_version == local_version:
            print("Status: current")
            return 0
        print("Status: update available")
        return 10

    release_tag = args.release
    staging_root = None
    if args.candidate_dir is not None:
        candidate = locate_pi_tree(args.candidate_dir.resolve())
    elif args.archive is not None:
        if release_tag is None:
            raise CheckError("--archive requires --release skill-vX.Y.Z.")
        if not args.staging_parent.is_dir():
            raise CheckError(f"Staging parent is not a directory: {args.staging_parent}")
        candidate, staging_root = staged_archive(
            args.archive.resolve(), args.staging_parent.resolve()
        )
    else:
        release = release_by_tag(release_tag) if release_tag else latest_skill_release()
        release_tag = str(release["tag_name"])
        if not args.staging_parent.is_dir():
            raise CheckError(f"Staging parent is not a directory: {args.staging_parent}")
        candidate, staging_root = download_release(release, args.staging_parent.resolve())

    if staging_root is not None:
        print(f"Retained staging directory: {staging_root}")
    return compare_trees(candidate, release_tag)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CheckError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
