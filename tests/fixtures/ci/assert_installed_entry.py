#!/usr/bin/env python3
"""Assert the installed-entry CI run proved what it must prove.

Usage: assert_installed_entry.py <events.jsonl> <probe.json> <agent_dir>

Evidence model (each item names the failure it would catch):
- receipt exists with permission hashes  -> installer broke
- probe lists the three harness skills   -> skill discovery broke
- required MCP definition in mcp.json    -> MCP merge broke
- bash rm blocked (no-ui), read gated no-ui, echo ok ran, in order
                                          -> permission policies not loaded
                                             / gating regressed / not
                                             blanket-blocking
- audit file written with session/request/outcome records
                                          -> audit-log extension not loaded
"""
import json
import sys
from pathlib import Path


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if len(sys.argv) != 4:
        fail(f"usage: {sys.argv[0]} <events.jsonl> <probe.json> <agent_dir>")

    events_path, probe_path, agent_dir = sys.argv[1], sys.argv[2], Path(sys.argv[3])

    # 1. Installer receipt with non-empty permission hashes.
    receipt_path = agent_dir / "harness" / ".managed-state.json"
    if not receipt_path.is_file():
        fail(f"no managed-state receipt at {receipt_path}")
    try:
        receipt = json.loads(receipt_path.read_text())
    except json.JSONDecodeError as exc:
        fail(f"managed-state receipt at {receipt_path} is not valid JSON: {exc}")
    hashes = [e.get("sha256") for e in receipt.get("permissions", [])]
    if not hashes or not all(hashes):
        fail(f"receipt has no permission sha256 entries: {receipt.get('permissions')!r}")

    # 2. Probe lists the three harness skills (names only, discovery proven).
    probe_file = Path(probe_path)
    if not probe_file.is_file():
        fail("probe extension never wrote its output — discovery not proven")
    try:
        probe = json.loads(probe_file.read_text())
    except json.JSONDecodeError as exc:
        fail(f"probe file at {probe_file} is not valid JSON: {exc}")
    # The "core" entry is a bundle directory whose members surface as their
    # own skill names (e.g. "brainstorming", "impeccable" is standalone),
    # so discovery of the three configured skill directories is proven by
    # each loaded skill's baseDir carrying the expected path suffix, not by
    # matching "core" against a skill name.
    skill_dirs = probe.get("skillDirs", [])
    for suffix in ("/harness/skills/core/", "/harness/skills/optimize-claude-prompt", "/harness/skills/impeccable"):
        if not any(suffix in d for d in skill_dirs):
            fail(f"skill directory {suffix!r} not discovered; probe saw {skill_dirs}")

    # 3. Required MCP definition present (config-merge proven).
    mcp_path = agent_dir / "mcp.json"
    if not mcp_path.is_file():
        fail(f"no mcp.json at {mcp_path}")
    try:
        mcp = json.loads(mcp_path.read_text())
    except json.JSONDecodeError as exc:
        fail(f"mcp.json at {mcp_path} is not valid JSON: {exc}")
    if "context7" not in json.dumps(mcp).lower():
        fail(f"required MCP definition (context7) missing from mcp.json: {mcp!r}")

    # 4. Exactly the three tool executions, in order: bash rm blocked
    #    (no-UI), read of secret blocked (no-UI), benign bash ran.
    events_file = Path(events_path)
    if not events_file.is_file():
        fail(f"no events file at {events_file}")
    ends = []
    for line in events_file.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "tool_execution_end":
            text = "".join(
                block.get("text", "")
                for block in event.get("result", {}).get("content", [])
                if isinstance(block, dict)
            )
            ends.append((event.get("toolName"), bool(event.get("isError")), text))
    if len(ends) != 3:
        fail(f"expected 3 tool executions, saw {len(ends)}: {ends!r}")
    (t1, e1, x1), (t2, e2, x2), (t3, e3, x3) = ends
    if not (t1 == "bash" and e1 and x1.startswith("Blocked ")):
        fail(f"destructive bash was not blocked: {(t1, e1, x1[:120])!r}")
    if not (t2 == "read" and e2 and "no UI available" in x2):
        fail(f"secret read was not headlessly gated: {(t2, e2, x2[:120])!r}")
    if not (t3 == "bash" and not e3 and "ok" in x3):
        fail(f"benign command did not run: {(t3, e3, x3[:120])!r}")

    # 5. Audit log captured session/request/outcome records.
    audit_dir = agent_dir / "harness" / "audit"
    audit_files = sorted(audit_dir.glob("audit-*.jsonl")) if audit_dir.is_dir() else []
    if not audit_files:
        fail("audit-log extension wrote nothing — extension loading not proven")
    records = []
    for f in audit_files:
        for l in f.read_text().splitlines():
            l = l.strip()
            if not l:
                continue
            try:
                records.append(json.loads(l))
            except json.JSONDecodeError as exc:
                fail(f"audit file {f} has invalid JSON line: {exc}")
    kinds = {record.get("kind") for record in records}
    if not {"session", "request", "outcome"} <= kinds:
        fail(f"audit log incomplete, kinds seen: {sorted(kinds)}")

    print("installed-entry assertions passed")


if __name__ == "__main__":
    main()
