import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  matchTool,
  request,
  type PermissionsAPI,
} from "@thurstonsand/pi-permissions";

import {
  findCredentialSearchRoot,
  findEnvironmentExposureCommands,
  findProtectedDirectory,
  findSecretPathReferences,
  findSensitiveRegistryReferences,
  findShellPathCandidates,
  isSecretFile,
} from "./lib/path-matchers.js";
import { resolvePhysicalPath } from "./lib/resolve-path.js";

// Protected locations from the AGENTS.md operating contract. File-tool
// writes and edits inside these directories require per-call approval.
// Forks: extend this list to match your own contract's protected paths
// (archives, model weights, datasets, backups, ...).
const PROTECTED_DIRECTORIES = [
  // Pi's own agent state: auth.json, mcp.json, settings.json, permissions.
  // An unapproved write here could redirect what Pi loads or trusts.
  "~/.pi",
  "~/.ssh",
  "~/.config",
  "~/.local/share",
];

const HOME = homedir();

function protectedPathDecision(lexicalPath: string) {
  const absolutePath = resolvePhysicalPath(lexicalPath);
  const entry = findProtectedDirectory(
    absolutePath,
    HOME,
    PROTECTED_DIRECTORIES,
  );
  if (!entry) {
    return undefined;
  }
  return request({
    guidance:
      `This operation modifies a file inside the protected location ` +
      `${entry}. Approve only if the user explicitly named this path and ` +
      "operation. Approval applies only to this tool call.",
    approveLabel: "Approve change",
    editLabel: "Edit",
    rejectLabel: "Reject change",
  });
}

export default function permissions(api: PermissionsAPI) {
  api.onToolUse({
    name: "protected path and secret access approval",
    description:
      "Require per-call approval for file-tool writes into protected " +
      "directories, reads of secret-shaped files, and shell commands " +
      "referencing secret paths, sensitive Windows Registry keys, or " +
      "environment values.",

    handler(input) {
      return matchTool(input.tool, {
        write(tool) {
          return protectedPathDecision(tool.absolutePath);
        },
        edit(tool) {
          return protectedPathDecision(tool.absolutePath);
        },
        read(tool) {
          const rule = isSecretFile(resolvePhysicalPath(tool.absolutePath), HOME);
          if (!rule) {
            return undefined;
          }
          return request({
            guidance:
              `This read matches a secret pattern (${rule}). The file's ` +
              "contents will enter model context and be transmitted to " +
              "the model provider. Approval applies only to this tool " +
              "call.",
            approveLabel: "Approve read",
            rejectLabel: "Reject read",
          });
        },
        bash(tool) {
          const pathFindings = findSecretPathReferences(tool.command, HOME);
          const registryFindings = findSensitiveRegistryReferences(tool.command);
          const environmentFindings = findEnvironmentExposureCommands(tool.command);
          const shellCandidates = findShellPathCandidates(tool.command, HOME);
          const resolvedFindings = shellCandidates.flatMap((candidate) => {
            const lexical = resolve(input.cwd ?? process.cwd(), candidate.path);
            const physical = resolvePhysicalPath(lexical);
            const rule = isSecretFile(physical, HOME);
            const searchRoot = candidate.contentSearch
              ? findCredentialSearchRoot(physical, HOME)
              : null;
            return rule || searchRoot
              ? [{ token: candidate.token, rule: rule ?? searchRoot! }]
              : [];
          });
          if (
            pathFindings.length === 0 &&
            registryFindings.length === 0 &&
            environmentFindings.length === 0 &&
            resolvedFindings.length === 0
          ) {
            return undefined;
          }
          const rules = [...new Set([
            ...pathFindings.map((finding) => finding.rule),
            ...registryFindings.map((finding) => finding.rule),
            ...environmentFindings.map((finding) => finding.reason),
            ...resolvedFindings.map((finding) => finding.rule),
          ])].join(", ");
          return request({
            guidance:
              `This command references or exposes secret material (${rules}). Its ` +
              "output will enter model context and be transmitted to the " +
              "model provider. Approval applies only to this tool call.",
            approveLabel: "Approve command",
            editLabel: "Edit command",
            rejectLabel: "Reject command",
          });
        },
        grep(tool) {
          if (!tool.absolutePath) {
            return undefined;
          }
          const resolved = resolvePhysicalPath(tool.absolutePath);
          const rule = isSecretFile(resolved, HOME);
          const searchRoot = findCredentialSearchRoot(resolved, HOME);
          if (!rule && !searchRoot) {
            return undefined;
          }
          return request({
            guidance:
              `This search targets ${rule ?? searchRoot} and returns matching ` +
              "file contents into model context. Approval applies only to " +
              "this tool call.",
            approveLabel: "Approve search",
            rejectLabel: "Reject search",
          });
        },
      });
    },
  });
}
