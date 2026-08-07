from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts" / "install.sh"
UNINSTALLER = ROOT / "scripts" / "uninstall.sh"

# Strings that must never appear in tracked files: private hostnames, IP
# addresses, and internal service names. Forks should replace the placeholder
# with their own real markers (see docs/FORKING.md); the placeholder keeps the
# guard exercised without publishing anything private.
PRIVATE_REFERENCE_MARKERS: tuple[str, ...] = (
    "REPLACE-WITH-YOUR-PRIVATE-HOSTNAME.example",
)
RESOURCES = ROOT / "config" / "resources.json"
PACKAGE_MANIFEST = ROOT / "packages" / "pi-packages.txt"
REQUIRED_MCP = ROOT / "config" / "required-mcp.json"
IMPECCABLE_CHECKER = ROOT / "scripts" / "check-impeccable.py"
VERSION_FILE = ROOT / "VERSION"


def harness_documents() -> list[Path]:
    documents = [
        ROOT / "AGENTS.md",
        ROOT / "CHANGELOG.md",
        ROOT / "README.md",
        ROOT / "THIRD_PARTY_NOTICES.md",
    ]
    documents.extend(sorted((ROOT / "docs").glob("*.md")))
    documents.extend(sorted((ROOT / "mcp").glob("*.md")))
    return documents


def read_frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return {}
    _, raw, _ = text.split("---", 2)
    result: dict[str, str] = {}
    for line in raw.strip().splitlines():
        if ":" not in line or line.startswith((" ", "\t")):
            continue
        key, value = line.split(":", 1)
        result[key.strip()] = value.strip()
    return result


def discover_skills(path: Path) -> list[Path]:
    if (path / "SKILL.md").is_file():
        return [path / "SKILL.md"]
    return sorted(path.rglob("SKILL.md"))


def test_passed(testcase: unittest.TestCase) -> bool:
    result = getattr(getattr(testcase, "_outcome", None), "result", None)
    if result is None:
        return False
    return all(
        test is not testcase for test, _ in result.errors + result.failures
    )


def retained_on_failure_tmpdir(testcase: unittest.TestCase, prefix: str) -> Path:
    """Create a fixture directory that is kept only when the test fails."""
    path = Path(tempfile.mkdtemp(prefix=prefix))

    def cleanup() -> None:
        if test_passed(testcase):
            shutil.rmtree(path, ignore_errors=True)

    testcase.addCleanup(cleanup)
    return path


class RepositoryValidationTests(unittest.TestCase):
    def test_documentation_matches_manifests(self) -> None:
        version = VERSION_FILE.read_text(encoding="utf-8").strip()
        packages = [
            line.strip()
            for line in PACKAGE_MANIFEST.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        deployment = (ROOT / "docs" / "DEPLOYMENT.md").read_text(
            encoding="utf-8"
        )
        capabilities = (ROOT / "docs" / "CAPABILITIES.md").read_text(
            encoding="utf-8"
        )
        notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        mcp_docs = "\n".join(
            path.read_text(encoding="utf-8")
            for path in sorted((ROOT / "mcp").glob("*.md"))
        )

        for document in (readme, deployment, changelog):
            self.assertIn(version, document)
        for package in packages:
            self.assertIn(package, capabilities + "\n" + notices)
        self.assertIn("https://mcp.context7.com/mcp", readme)
        self.assertIn("https://mcp.context7.com/mcp", capabilities)
        self.assertIn("https://mcp.context7.com/mcp", mcp_docs)
        self.assertIn("## Local Model Providers", capabilities)
        self.assertIn("/login llama.cpp", capabilities)
        self.assertIn("extensions/local-models.ts", capabilities)

    def test_no_private_reference_markers_in_tracked_files(self) -> None:
        tracked = subprocess.run(
            ["git", "ls-files"],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            check=True,
        ).stdout.splitlines()
        self.assertTrue(tracked, "expected a git repository with tracked files")
        this_file = Path(__file__).resolve()
        for relative in tracked:
            path = ROOT / relative
            if not path.is_file() or path.resolve() == this_file:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for marker in PRIVATE_REFERENCE_MARKERS:
                self.assertNotIn(
                    marker,
                    text,
                    f"{relative} contains the private reference marker {marker!r}",
                )

    def test_harness_document_links_resolve_locally(self) -> None:
        markdown_link = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
        for document in harness_documents():
            text = document.read_text(encoding="utf-8")
            for raw_target in markdown_link.findall(text):
                target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
                if target.startswith(("#", "http://", "https://", "mailto:")):
                    continue
                relative_target = target.split("#", 1)[0]
                if not relative_target:
                    continue
                resolved = (document.parent / relative_target).resolve()
                with self.subTest(document=document, target=target):
                    self.assertTrue(resolved.is_relative_to(ROOT), resolved)
                    self.assertTrue(resolved.exists(), resolved)

    def test_installer_has_one_entrypoint(self) -> None:
        for script in (INSTALLER, UNINSTALLER):
            text = script.read_text(encoding="utf-8")
            self.assertEqual(text.count("#!/usr/bin/env bash"), 1)
            self.assertEqual(len(re.findall(r"^main\(\)", text, re.MULTILINE)), 1)
            self.assertEqual(len(re.findall(r'^main "\$@"$', text, re.MULTILINE)), 1)

    def test_shared_skill_trees_do_not_drift(self) -> None:
        claude_tree = ROOT / "skills" / "claude"
        codex_tree = ROOT / "skills" / "codex"
        shared = sorted(
            entry.name
            for entry in claude_tree.iterdir()
            if entry.is_dir() and (codex_tree / entry.name).is_dir()
        )
        self.assertTrue(shared, "expected shared skills in both trees")
        for name in shared:
            claude_skill = claude_tree / name
            codex_skill = codex_tree / name
            claude_files = {
                path.relative_to(claude_skill): path
                for path in claude_skill.rglob("*")
                if path.is_file()
            }
            codex_files = {
                path.relative_to(codex_skill): path
                for path in codex_skill.rglob("*")
                if path.is_file()
            }
            with self.subTest(skill=name):
                self.assertEqual(set(claude_files), set(codex_files))
                for relative, claude_file in claude_files.items():
                    self.assertEqual(
                        claude_file.read_bytes(),
                        codex_files[relative].read_bytes(),
                        f"{name}/{relative} differs between skills/claude and skills/codex",
                    )

    def test_agents_contract_is_not_duplicated(self) -> None:
        text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        self.assertEqual(text.count("# Global Agent Operating Contract"), 1)
        self.assertIn("### Explicit deletion consent", text)
        self.assertIn("## Capability selection", text)
        self.assertIn("### Context7", text)
        self.assertIn("Do not let a third-party skill update", text)

    def test_package_sources_are_exactly_pinned(self) -> None:
        sources = [
            line.strip()
            for line in PACKAGE_MANIFEST.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertTrue(sources)
        for source in sources:
            is_npm_pin = re.fullmatch(
                r"npm:(?:@[^/]+/)?[^@]+@\d+\.\d+\.\d+", source
            )
            is_git_pin = re.fullmatch(
                r"git:github\.com/[^/]+/[^@]+@(?:v?\d+\.\d+\.\d+|[0-9a-f]{7,40})",
                source,
            )
            self.assertTrue(is_npm_pin or is_git_pin, source)
        self.assertIn(
            "git:github.com/obra/superpowers"
            "@d884ae04edebef577e82ff7c4e143debd0bbec99",
            sources,
        )
        for source in sources:
            self.assertNotRegex(
                source,
                r"^git:.*@v?\d+\.\d+\.\d+$",
                f"git source {source} is pinned to a mutable tag; pin the commit",
            )

    def test_required_setup_includes_context7_and_impeccable(self) -> None:
        mcp = json.loads(REQUIRED_MCP.read_text(encoding="utf-8"))
        self.assertEqual(
            mcp["mcpServers"]["context7"],
            {
                "url": "https://mcp.context7.com/mcp",
                "lifecycle": "lazy",
            },
        )
        resources = json.loads(RESOURCES.read_text(encoding="utf-8"))
        self.assertIn(
            {"name": "impeccable", "source": ".pi/skills/impeccable"},
            resources["skills"],
        )
        self.assertEqual(
            {entry["path"] for entry in resources["skillExclusions"]},
            {
                "~/.codex/skills/optimize-gpt-5-6-prompt",
                "~/.claude/skills/optimize-claude-prompt",
            },
        )
        self.assertTrue(
            all(entry["reason"].strip() for entry in resources["skillExclusions"])
        )

    def test_resource_manifest_is_collision_free(self) -> None:
        manifest = json.loads(RESOURCES.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schemaVersion"], 1)
        names: dict[str, Path] = {}
        for kind in ("skills", "prompts"):
            for resource in manifest[kind]:
                self.assertRegex(resource["name"], r"^[a-z0-9][a-z0-9-]*$")
                source = (ROOT / resource["source"]).resolve()
                self.assertTrue(source.is_relative_to(ROOT))
                self.assertTrue(source.exists(), source)
                if kind != "skills":
                    continue
                for skill_file in discover_skills(source):
                    frontmatter = read_frontmatter(skill_file)
                    name = frontmatter.get("name", skill_file.parent.name)
                    description = frontmatter.get("description", "")
                    self.assertRegex(name, r"^[a-z0-9][a-z0-9-]{0,63}$")
                    self.assertTrue(description, skill_file)
                    self.assertLessEqual(len(description), 1024, skill_file)
                    self.assertNotIn(
                        name,
                        names,
                        f"skill {name!r} collides: {names.get(name)} and {skill_file}",
                    )
                    names[name] = skill_file

    def test_json_files_are_valid_including_placeholders(self) -> None:
        for path in sorted((ROOT / "mcp").glob("*.json")):
            with self.subTest(path=path):
                value = json.loads(path.read_text(encoding="utf-8"))
                self.assertIsInstance(value, dict)

    def test_third_party_skill_inventory_is_current(self) -> None:
        inventory_path = ROOT / "config" / "third-party-skills.json"
        inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
        self.assertEqual(inventory["schemaVersion"], 1)
        for entry in inventory["skills"]:
            self.assertTrue(entry["sourceRepository"].startswith("https://github.com/"))
            self.assertTrue(entry["license"])
            self.assertRegex(entry["contentSha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(entry["reviewedAt"])
            self.assertTrue(entry["reviewStatus"])
            for relative_path in entry["paths"]:
                self.assertTrue((ROOT / relative_path).exists(), relative_path)

            if entry["hashFormat"].startswith("sha256(SKILL.md bytes)"):
                hashes = {
                    hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
                    for path in entry["paths"]
                }
                self.assertEqual(hashes, {entry["contentSha256"]})
            elif entry["hashFormat"].startswith("sha256(path + NUL"):
                self.assertEqual(len(entry["paths"]), 1)
                tree_root = ROOT / entry["paths"][0]
                digest = hashlib.sha256()
                for path in sorted(item for item in tree_root.rglob("*") if item.is_file()):
                    digest.update(path.relative_to(tree_root).as_posix().encode())
                    digest.update(b"\0")
                    digest.update(path.read_bytes())
                    digest.update(b"\0")
                self.assertEqual(digest.hexdigest(), entry["contentSha256"])
            else:
                self.fail(f"Unsupported provenance hash format: {entry['hashFormat']}")

            if entry["name"] == "impeccable":
                self.assertEqual(entry["sourcePath"], ".pi/skills/impeccable")
                self.assertEqual(entry["sourceRef"], entry["upstreamReleaseTag"])
                self.assertEqual(
                    entry["upstreamReleaseTag"], f"skill-v{entry['version']}"
                )
                self.assertRegex(entry["upstreamReleaseCommit"], r"^[0-9a-f]{40}$")
                self.assertIn("verified byte-identical", entry["reviewStatus"])

    def test_impeccable_checker_accepts_identical_candidate(self) -> None:
        result = subprocess.run(
            [
                str(IMPECCABLE_CHECKER),
                "compare",
                "--candidate-dir",
                str(ROOT / ".pi" / "skills" / "impeccable"),
                "--release",
                "skill-v4.0.4",
            ],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("Status: identical", result.stdout)
        self.assertIn(
            "1427222770f2c19f78471554a3f717a8946feb49e9a9882543be242c7a27570f",
            result.stdout,
        )

    def test_impeccable_checker_stages_archive_without_mutating_local_tree(self) -> None:
        fixture_root = retained_on_failure_tmpdir(self, "impeccable-check-test-")
        archive = fixture_root / "universal.zip"
        local_hash_before = hashlib.sha256(
            (ROOT / ".pi" / "skills" / "impeccable" / "SKILL.md").read_bytes()
        ).hexdigest()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr(
                ".pi/skills/impeccable/SKILL.md",
                "---\nname: impeccable\ndescription: Staged fixture.\nversion: 9.9.9\n---\n",
            )
            bundle.writestr(
                ".pi/skills/impeccable/reference/example.md", "staged fixture\n"
            )

        result = subprocess.run(
            [
                str(IMPECCABLE_CHECKER),
                "compare",
                "--archive",
                str(archive),
                "--release",
                "skill-v9.9.9",
                "--staging-parent",
                str(fixture_root),
            ],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        self.assertEqual(result.returncode, 10, result.stdout)
        self.assertIn("Retained staging directory:", result.stdout)
        self.assertIn("Status: review required", result.stdout)
        self.assertEqual(
            hashlib.sha256(
                (ROOT / ".pi" / "skills" / "impeccable" / "SKILL.md").read_bytes()
            ).hexdigest(),
            local_hash_before,
        )

    def test_impeccable_checker_rejects_archive_traversal(self) -> None:
        fixture_root = retained_on_failure_tmpdir(self, "impeccable-unsafe-test-")
        archive = fixture_root / "unsafe.zip"
        escaped = fixture_root.parent / f"{fixture_root.name}-escaped.txt"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr(f"../{escaped.name}", "must not escape\n")

        result = subprocess.run(
            [
                str(IMPECCABLE_CHECKER),
                "compare",
                "--archive",
                str(archive),
                "--release",
                "skill-v9.9.9",
                "--staging-parent",
                str(fixture_root),
            ],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("Unsafe path in release archive", result.stdout)
        self.assertFalse(escaped.exists(), result.stdout)

    def test_destructive_fallback_patterns(self) -> None:
        script = """
import { findDestructiveFallbacks } from './permissions/lib/destructive-patterns.js';
const cases = JSON.parse(process.argv[1]);
for (const item of cases) {
  const matched = findDestructiveFallbacks(item.command).length > 0;
  if (matched !== item.expected) {
    console.error(JSON.stringify({ ...item, matched }));
    process.exit(1);
  }
}
"""
        cases = [
            {"command": "python3 -c 'import os; os.remove(\"x\")'", "expected": True},
            {"command": "node -e 'require(\"fs\").rmSync(\"x\")'", "expected": True},
            {"command": "perl -e 'unlink glob \"*.bak\"'", "expected": True},
            {"command": "bash -c 'rm -rf build'", "expected": True},
            {"command": "sh -lc \"unlink stale.lock\"", "expected": True},
            {"command": "find . -print0 | xargs -0 rm", "expected": True},
            {"command": "rsync -a --delete src/ dst/", "expected": True},
            {"command": "dd if=/dev/zero of=data.bin bs=1M count=1", "expected": True},
            {"command": "git stash drop", "expected": True},
            {"command": "git stash clear", "expected": True},
            {"command": "git branch -D feature", "expected": True},
            {"command": "git push --force origin main", "expected": True},
            {"command": "git push -f", "expected": True},
            {"command": "git push origin main --force-with-lease", "expected": True},
            {"command": ": > generated.txt", "expected": True},
            {"command": "truncate -s 0 generated.txt", "expected": True},
            {"command": "python3 -m json.tool settings.json", "expected": False},
            {"command": "node --check script.js", "expected": False},
            {"command": "perl -e 'print \"hello\"'", "expected": False},
            {"command": "bash build.sh", "expected": False},
            {"command": "ssh host uptime", "expected": False},
            {"command": "rsync -a src/ dst/", "expected": False},
            {"command": "dd if=disk.img of=/dev/null", "expected": False},
            {"command": "git stash list", "expected": False},
            {"command": "git branch -d merged-feature", "expected": False},
            {"command": "git push origin main", "expected": False},
            {"command": "git push --no-verify origin main", "expected": False},
            {"command": "printf '%s\\n' hello", "expected": False},
        ]
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script, json.dumps(cases)],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_local_models_extension_pure_functions(self) -> None:
        script = """
import {
  mapDiscoveredModels,
  normalizeBaseUrl,
  LOCAL_PROVIDER_TARGETS,
} from './extensions/local-models.ts';
const assert = (cond, msg) => {
  if (!cond) { console.error('ASSERT: ' + msg); process.exit(1); }
};
const models = mapDiscoveredModels([
  { id: 'qwen3-coder:30b' },
  { id: 'llama3.1:8b' },
  { id: 'llama3.1:8b' },
  { id: '  ' },
  'junk',
  { id: 42 },
]);
assert(models.length === 2, 'dedup and invalid-entry filtering, got ' + models.length);
assert(models[0].id === 'qwen3-coder:30b', 'id preserved');
assert(models[0].name === 'qwen3-coder:30b', 'name defaults to id');
assert(models[0].reasoning === true, 'qwen3 marked reasoning');
assert(models[1].reasoning === false, 'llama not marked reasoning');
assert(mapDiscoveredModels([{ id: 'gpt-oss:20b' }])[0].reasoning === true, 'gpt-oss reasoning');
assert(mapDiscoveredModels([{ id: 'deepseek-r1:7b' }])[0].reasoning === true, 'deepseek-r1 reasoning');
assert(models[0].contextWindow === 32768 && models[0].maxTokens === 4096, 'default limits');
assert(models[0].cost.input === 0 && models[0].cost.output === 0
  && models[0].cost.cacheRead === 0 && models[0].cost.cacheWrite === 0, 'zero cost');
assert(models[0].input.length === 1 && models[0].input[0] === 'text', 'text input only');
assert(mapDiscoveredModels('nope').length === 0, 'non-array payload maps to empty');
assert(mapDiscoveredModels([]).length === 0, 'empty payload maps to empty');
assert(normalizeBaseUrl(undefined, 'http://127.0.0.1:11434') === 'http://127.0.0.1:11434', 'undefined falls back');
assert(normalizeBaseUrl('   ', 'http://127.0.0.1:1234') === 'http://127.0.0.1:1234', 'blank falls back');
assert(normalizeBaseUrl('127.0.0.1:11500', 'x') === 'http://127.0.0.1:11500', 'host:port gains scheme');
assert(normalizeBaseUrl('http://box:8080/', 'x') === 'http://box:8080', 'trailing slash stripped');
assert(normalizeBaseUrl('http://box:8080/v1', 'x') === 'http://box:8080', 'trailing /v1 stripped');
assert(normalizeBaseUrl('localhost', 'http://127.0.0.1:11434') === 'http://localhost:11434', 'bare host gains fallback port');
assert(normalizeBaseUrl('box:9999', 'http://127.0.0.1:11434') === 'http://box:9999', 'explicit port preserved');
const controlCharId = mapDiscoveredModels([{ id: 'bad\\u0007id' }]);
assert(controlCharId.length === 1 && controlCharId[0].id === 'badid', 'control chars stripped from id, got ' + JSON.stringify(controlCharId));
assert(mapDiscoveredModels([{ id: '\\u0007' }]).length === 0, 'control-char-only id skipped');
assert(mapDiscoveredModels(Array.from({ length: 250 }, (_, i) => ({ id: 'm' + i }))).length === 200, '200-model cap enforced');
assert(LOCAL_PROVIDER_TARGETS.map(t => t.providerId).join(',') === 'ollama,lmstudio', 'targets');
assert(LOCAL_PROVIDER_TARGETS[0].envVar === 'OLLAMA_HOST', 'ollama env var');
assert(LOCAL_PROVIDER_TARGETS[1].envVar === 'LMSTUDIO_BASE_URL', 'lmstudio env var');
"""
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        if result.returncode != 0 and "bad option" in result.stdout:
            self.skipTest("Node.js on PATH cannot strip TypeScript types")
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_typescript_permission_policy_parses(self) -> None:
        # Node 22.6+ can strip types; the loader in Pi does the same. Without
        # this check, a syntax error in the policy would only surface at Pi
        # load time. --check parses without resolving package imports.
        for module in (
            ROOT / "permissions" / "confirm-deletions.ts",
            ROOT / "extensions" / "local-models.ts",
        ):
            with self.subTest(module=module.name):
                result = subprocess.run(
                    ["node", "--experimental-strip-types", "--check", str(module)],
                    cwd=ROOT,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
                if result.returncode != 0 and "bad option" in result.stdout:
                    self.skipTest("Node.js on PATH cannot strip TypeScript types")
                self.assertEqual(result.returncode, 0, result.stdout)


class InstallerBehaviorTests(unittest.TestCase):
    def setUp(self) -> None:
        # Fixtures are removed when the test passes and retained for
        # post-failure inspection; verbose unittest output names the root.
        self.fixture_root = retained_on_failure_tmpdir(self, "pi-harness-test-")
        self.bin_dir = self.fixture_root / "bin"
        self.bin_dir.mkdir()
        self.pi_log = self.fixture_root / "pi-calls.log"
        fake_pi = self.bin_dir / "pi"
        fake_pi.write_text(
            "#!/usr/bin/env bash\n"
            "printf '%s\\n' \"$*\" >>\"$PI_TEST_LOG\"\n",
            encoding="utf-8",
        )
        fake_pi.chmod(fake_pi.stat().st_mode | stat.S_IXUSR)

    def run_script(
        self, script: Path, *args: str, agent_dir: Path | None = None
    ) -> subprocess.CompletedProcess[str]:
        target = agent_dir or self.fixture_root / "agent"
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin_dir}:{env['PATH']}",
                "PI_AGENT_DIR": str(target),
                "PI_TEST_LOG": str(self.pi_log),
            }
        )
        return subprocess.run(
            [str(script), *args],
            cwd=ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

    def run_installer(self, *args: str, agent_dir: Path | None = None) -> subprocess.CompletedProcess[str]:
        return self.run_script(INSTALLER, *args, agent_dir=agent_dir)

    def run_uninstaller(self, *args: str, agent_dir: Path | None = None) -> subprocess.CompletedProcess[str]:
        return self.run_script(UNINSTALLER, *args, agent_dir=agent_dir)

    def test_dry_run_is_non_mutating(self) -> None:
        agent_dir = self.fixture_root / "dry-agent"
        result = self.run_installer("--dry-run", agent_dir=agent_dir)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse(agent_dir.exists(), result.stdout)
        self.assertFalse(self.pi_log.exists(), result.stdout)
        self.assertIn("Would register skills path", result.stdout)

    def test_existing_skill_name_collision_is_reported_without_mutation(self) -> None:
        agent_dir = self.fixture_root / "collision-agent"
        external_skills = self.fixture_root / "external-skills"
        duplicate = external_skills / "find-skills"
        duplicate.mkdir(parents=True)
        (duplicate / "SKILL.md").write_text(
            "---\nname: find-skills\ndescription: External duplicate.\n---\n",
            encoding="utf-8",
        )
        agent_dir.mkdir()
        settings = agent_dir / "settings.json"
        original = json.dumps({"skills": [str(external_skills)]}) + "\n"
        settings.write_text(original, encoding="utf-8")

        result = self.run_installer("--dry-run", "--skip-packages", agent_dir=agent_dir)

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("duplicate skill name", result.stdout)
        self.assertIn("'find-skills'", result.stdout)
        self.assertEqual(settings.read_text(encoding="utf-8"), original)
        self.assertFalse((agent_dir / "AGENTS.md").exists(), result.stdout)

    def test_fresh_install_and_idempotent_rerun(self) -> None:
        agent_dir = self.fixture_root / "fresh-agent"
        first = self.run_installer("--skip-packages", agent_dir=agent_dir)
        self.assertEqual(first.returncode, 0, first.stdout)
        second = self.run_installer("--skip-packages", agent_dir=agent_dir)
        self.assertEqual(second.returncode, 0, second.stdout)

        self.assertEqual((agent_dir / "AGENTS.md").resolve(), (ROOT / "AGENTS.md").resolve())
        for permission_name in (
            "confirm-deletions.ts",
            "destructive-patterns.js",
            "lib/destructive-patterns.js",
        ):
            installed_permission = agent_dir / "permissions" / permission_name
            source_permission = ROOT / "permissions" / permission_name
            self.assertTrue(installed_permission.is_file())
            self.assertFalse(installed_permission.is_symlink())
            self.assertEqual(
                installed_permission.read_bytes(), source_permission.read_bytes()
            )

        manifest = json.loads(RESOURCES.read_text(encoding="utf-8"))
        settings = json.loads((agent_dir / "settings.json").read_text(encoding="utf-8"))
        expected = {
            kind: [str(agent_dir / "harness" / kind / item["name"]) for item in manifest[kind]]
            for kind in ("skills", "prompts")
        }
        for kind, paths in expected.items():
            for path in paths:
                self.assertIn(path, settings.get(kind, []))
        expected_exclusions = {
            f"-{Path(entry['path']).expanduser().resolve(strict=False)}"
            for entry in manifest["skillExclusions"]
        }
        self.assertTrue(expected_exclusions.issubset(settings["skills"]))

        self.assertEqual(
            json.loads((agent_dir / "mcp.json").read_text(encoding="utf-8")),
            json.loads(REQUIRED_MCP.read_text(encoding="utf-8")),
        )

        extension_link = agent_dir / "extensions" / "local-models.ts"
        self.assertTrue(extension_link.is_symlink(), second.stdout)
        self.assertEqual(
            extension_link.resolve(),
            (ROOT / "extensions" / "local-models.ts").resolve(),
        )
        self.assertIn("Harness extension local-models.ts: valid", second.stdout)

        backups = agent_dir / "backups"
        self.assertFalse(backups.exists(), "idempotent install unexpectedly created backups")

    def test_legacy_permission_symlinks_are_migrated_to_regular_files(self) -> None:
        agent_dir = self.fixture_root / "permission-link-agent"
        permissions_dir = agent_dir / "permissions"
        permissions_dir.mkdir(parents=True)
        legacy_names = ("confirm-deletions.ts", "destructive-patterns.js")
        installed_names = (*legacy_names, "lib/destructive-patterns.js")
        for name in legacy_names:
            (permissions_dir / name).symlink_to(ROOT / "permissions" / name)

        result = self.run_installer("--skip-packages", agent_dir=agent_dir)

        self.assertEqual(result.returncode, 0, result.stdout)
        for name in installed_names:
            installed = permissions_dir / name
            self.assertTrue(installed.is_file())
            self.assertFalse(installed.is_symlink())
            self.assertEqual(installed.read_bytes(), (ROOT / "permissions" / name).read_bytes())

        backups = sorted((agent_dir / "backups").glob("harness-*/permissions/*"))
        self.assertEqual([path.name for path in backups], sorted(legacy_names))
        self.assertTrue(all(path.is_symlink() for path in backups))

    def test_package_install_uses_exact_pins(self) -> None:
        agent_dir = self.fixture_root / "package-agent"
        result = self.run_installer(agent_dir=agent_dir)
        self.assertEqual(result.returncode, 0, result.stdout)
        actual = self.pi_log.read_text(encoding="utf-8").splitlines()
        expected = [
            f"install {line.strip()}"
            for line in PACKAGE_MANIFEST.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertEqual(actual, expected)

    def test_existing_agents_file_is_preserved(self) -> None:
        agent_dir = self.fixture_root / "existing-agent"
        agent_dir.mkdir()
        existing = agent_dir / "AGENTS.md"
        existing.write_text("existing user contract\n", encoding="utf-8")
        result = self.run_installer("--skip-packages", agent_dir=agent_dir)
        self.assertEqual(result.returncode, 0, result.stdout)
        backups = list((agent_dir / "backups").glob("*/AGENTS.md"))
        self.assertEqual(len(backups), 1, result.stdout)
        self.assertEqual(backups[0].read_text(encoding="utf-8"), "existing user contract\n")

    def test_existing_mcp_servers_are_preserved(self) -> None:
        agent_dir = self.fixture_root / "existing-mcp-agent"
        agent_dir.mkdir()
        mcp_file = agent_dir / "mcp.json"
        original = {
            "settings": {"toolPrefix": "server"},
            "mcpServers": {
                "user-docs": {
                    "url": "https://docs.example.test/mcp",
                    "lifecycle": "lazy",
                }
            },
        }
        mcp_file.write_text(json.dumps(original) + "\n", encoding="utf-8")

        result = self.run_installer("--skip-packages", agent_dir=agent_dir)

        self.assertEqual(result.returncode, 0, result.stdout)
        installed = json.loads(mcp_file.read_text(encoding="utf-8"))
        self.assertEqual(installed["settings"], original["settings"])
        self.assertEqual(
            installed["mcpServers"]["user-docs"],
            original["mcpServers"]["user-docs"],
        )
        self.assertEqual(
            installed["mcpServers"]["context7"],
            json.loads(REQUIRED_MCP.read_text(encoding="utf-8"))["mcpServers"]["context7"],
        )
        backups = list((agent_dir / "backups").glob("*/mcp.json"))
        self.assertEqual(len(backups), 1, result.stdout)
        self.assertEqual(json.loads(backups[0].read_text(encoding="utf-8")), original)

    def test_conflicting_required_mcp_server_fails_before_mutation(self) -> None:
        agent_dir = self.fixture_root / "conflicting-mcp-agent"
        agent_dir.mkdir()
        mcp_file = agent_dir / "mcp.json"
        original = json.dumps(
            {"mcpServers": {"context7": {"url": "https://example.test/mcp"}}}
        ) + "\n"
        mcp_file.write_text(original, encoding="utf-8")

        result = self.run_installer("--skip-packages", agent_dir=agent_dir)

        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("conflicts with the required harness definition", result.stdout)
        self.assertEqual(mcp_file.read_text(encoding="utf-8"), original)
        self.assertFalse((agent_dir / "AGENTS.md").exists(), result.stdout)
        self.assertFalse((agent_dir / "harness").exists(), result.stdout)

    def test_context7_private_auth_fields_are_preserved(self) -> None:
        agent_dir = self.fixture_root / "authenticated-context7-agent"
        agent_dir.mkdir()
        context7 = {
            **json.loads(REQUIRED_MCP.read_text(encoding="utf-8"))["mcpServers"]["context7"],
            "headers": {"CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"},
        }
        (agent_dir / "mcp.json").write_text(
            json.dumps({"mcpServers": {"context7": context7}}) + "\n",
            encoding="utf-8",
        )

        result = self.run_installer("--skip-packages", agent_dir=agent_dir)

        self.assertEqual(result.returncode, 0, result.stdout)
        installed = json.loads((agent_dir / "mcp.json").read_text(encoding="utf-8"))
        self.assertEqual(installed["mcpServers"]["context7"], context7)
        self.assertFalse(
            list((agent_dir / "backups").glob("*/mcp.json"))
            if (agent_dir / "backups").exists()
            else [],
            result.stdout,
        )

    def test_legacy_aggregate_resource_link_is_migrated(self) -> None:
        agent_dir = self.fixture_root / "legacy-agent"
        legacy_source = self.fixture_root / "legacy-skills"
        legacy_source.mkdir()
        (legacy_source / "marker.txt").write_text("legacy\n", encoding="utf-8")
        aggregate = agent_dir / "harness" / "skills"
        aggregate.parent.mkdir(parents=True)
        aggregate.symlink_to(legacy_source, target_is_directory=True)
        (agent_dir / "settings.json").write_text(
            json.dumps({"skills": [str(aggregate), str(ROOT / "skills")]}) + "\n",
            encoding="utf-8",
        )

        result = self.run_installer("--skip-packages", agent_dir=agent_dir)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(aggregate.is_dir())
        self.assertFalse(aggregate.is_symlink())
        self.assertTrue((aggregate / "core").is_symlink())
        backups = list((agent_dir / "backups").glob("*/harness/skills"))
        self.assertEqual(len(backups), 1, result.stdout)
        self.assertTrue(backups[0].is_symlink())

        settings = json.loads((agent_dir / "settings.json").read_text(encoding="utf-8"))
        self.assertNotIn(str(aggregate), settings["skills"])
        self.assertNotIn(str(ROOT / "skills"), settings["skills"])

    def test_stale_extension_link_is_migrated_with_backup(self) -> None:
        agent_dir = self.fixture_root / "extension-link-agent"
        extensions_dir = agent_dir / "extensions"
        extensions_dir.mkdir(parents=True)
        stale_target = self.fixture_root / "elsewhere.ts"
        stale_target.write_text("export default function () {}\n", encoding="utf-8")
        (extensions_dir / "local-models.ts").symlink_to(stale_target)

        result = self.run_installer("--skip-packages", agent_dir=agent_dir)

        self.assertEqual(result.returncode, 0, result.stdout)
        installed = extensions_dir / "local-models.ts"
        self.assertTrue(installed.is_symlink())
        self.assertEqual(
            installed.resolve(),
            (ROOT / "extensions" / "local-models.ts").resolve(),
        )
        backups = list((agent_dir / "backups").glob("*/extensions/local-models.ts"))
        self.assertEqual(len(backups), 1, result.stdout)

    def test_invalid_settings_fail_before_mutation(self) -> None:
        agent_dir = self.fixture_root / "invalid-agent"
        agent_dir.mkdir()
        settings = agent_dir / "settings.json"
        settings.write_text("not-json\n", encoding="utf-8")
        before = hashlib.sha256(settings.read_bytes()).hexdigest()
        result = self.run_installer("--skip-packages", agent_dir=agent_dir)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(hashlib.sha256(settings.read_bytes()).hexdigest(), before)
        self.assertFalse((agent_dir / "AGENTS.md").exists(), result.stdout)
        self.assertFalse((agent_dir / "harness").exists(), result.stdout)

    def test_uninstall_reverses_install_and_preserves_user_state(self) -> None:
        agent_dir = self.fixture_root / "uninstall-agent"
        agent_dir.mkdir()
        user_skills = self.fixture_root / "user-skills"
        user_skills.mkdir()
        (agent_dir / "settings.json").write_text(
            json.dumps({"skills": [str(user_skills)], "theme": "dark"}) + "\n",
            encoding="utf-8",
        )
        (agent_dir / "mcp.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "user-docs": {"url": "https://docs.example.test/mcp"}
                    }
                }
            )
            + "\n",
            encoding="utf-8",
        )

        install = self.run_installer("--skip-packages", agent_dir=agent_dir)
        self.assertEqual(install.returncode, 0, install.stdout)
        uninstall = self.run_uninstaller(agent_dir=agent_dir)
        self.assertEqual(uninstall.returncode, 0, uninstall.stdout)

        self.assertFalse((agent_dir / "AGENTS.md").exists(), uninstall.stdout)
        self.assertFalse((agent_dir / "harness").exists(), uninstall.stdout)
        self.assertFalse((agent_dir / "permissions").exists(), uninstall.stdout)
        self.assertFalse((agent_dir / "extensions").exists(), uninstall.stdout)

        settings = json.loads((agent_dir / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(settings.get("skills"), [str(user_skills)])
        self.assertEqual(settings.get("theme"), "dark")
        self.assertNotIn("prompts", settings)

        mcp = json.loads((agent_dir / "mcp.json").read_text(encoding="utf-8"))
        self.assertNotIn("context7", mcp.get("mcpServers", {}))
        self.assertIn("user-docs", mcp["mcpServers"])

        backups = list((agent_dir / "backups").glob("harness-uninstall-*/settings.json"))
        self.assertEqual(len(backups), 1, uninstall.stdout)

    def test_uninstall_dry_run_is_non_mutating(self) -> None:
        agent_dir = self.fixture_root / "uninstall-dry-agent"
        install = self.run_installer("--skip-packages", agent_dir=agent_dir)
        self.assertEqual(install.returncode, 0, install.stdout)
        settings_before = (agent_dir / "settings.json").read_bytes()

        result = self.run_uninstaller("--dry-run", agent_dir=agent_dir)

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue((agent_dir / "AGENTS.md").is_symlink(), result.stdout)
        self.assertTrue((agent_dir / "harness" / "skills" / "core").is_symlink())
        self.assertTrue(
            (agent_dir / "permissions" / "confirm-deletions.ts").is_file()
        )
        self.assertEqual((agent_dir / "settings.json").read_bytes(), settings_before)
        self.assertIn("Dry run complete", result.stdout)

    def test_uninstall_leaves_modified_and_foreign_state_in_place(self) -> None:
        agent_dir = self.fixture_root / "uninstall-modified-agent"
        install = self.run_installer("--skip-packages", agent_dir=agent_dir)
        self.assertEqual(install.returncode, 0, install.stdout)

        modified = agent_dir / "permissions" / "confirm-deletions.ts"
        modified.write_text("// user-modified policy\n", encoding="utf-8")
        mcp_file = agent_dir / "mcp.json"
        mcp = json.loads(mcp_file.read_text(encoding="utf-8"))
        mcp["mcpServers"]["context7"]["headers"] = {
            "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
        }
        mcp_file.write_text(json.dumps(mcp) + "\n", encoding="utf-8")

        result = self.run_uninstaller(agent_dir=agent_dir)

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(modified.is_file(), result.stdout)
        self.assertIn("leaving it in place", result.stdout)
        installed_mcp = json.loads(mcp_file.read_text(encoding="utf-8"))
        self.assertIn("context7", installed_mcp["mcpServers"], result.stdout)
        self.assertFalse((agent_dir / "AGENTS.md").exists(), result.stdout)
        self.assertFalse((agent_dir / "harness").exists(), result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
