import { homedir } from "node:os";

import {
  matchTool,
  request,
  type PermissionsAPI,
} from "@thurstonsand/pi-permissions";

import {
  findProtectedDirectory,
  findSecretPathReferences,
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
      "referencing secret paths.",

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
          const findings = findSecretPathReferences(tool.command, HOME);
          if (findings.length === 0) {
            return undefined;
          }
          const rules = [...new Set(findings.map((f) => f.rule))].join(", ");
          return request({
            guidance:
              `This command references secret material (${rules}). Its ` +
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
          const directory = findProtectedDirectory(
            resolved,
            HOME,
            PROTECTED_DIRECTORIES,
          );
          const rule = isSecretFile(resolved, HOME);
          if (!directory && !rule) {
            return undefined;
          }
          return request({
            guidance:
              `This search targets ${rule ?? directory} and returns matching ` +
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
