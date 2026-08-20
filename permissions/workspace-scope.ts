import { homedir } from "node:os";

import {
  matchTool,
  request,
  type PermissionsAPI,
} from "@thurstonsand/pi-permissions";

import { logPermissionRequest } from "./lib/audit.ts";
import {
  findWorkspaceEscapes,
  isOutsideWorkspace,
} from "./lib/path-matchers.js";
import { resolvePhysicalPath } from "./lib/resolve-path.js";

// The session's working tree is the workspace boundary: file-tool writes
// and shell path references outside it require per-call approval. Reads
// stay ungated here — secret-shaped reads are covered by the
// protected-paths policy. OS scratch space and read-only pseudo-
// filesystems stay usable without prompts.
const EXEMPT_PREFIXES = [
  "/tmp",
  // macOS resolves /tmp through the /private symlink.
  "/private/tmp",
  "/var/tmp",
  "/dev",
  "/proc",
  "/sys",
];

const HOME = homedir();

export default function permissions(api: PermissionsAPI) {
  api.onToolUse({
    name: "workspace scope approval",
    description:
      "Require per-call approval for file-tool writes and shell path " +
      "references outside the session's working tree.",

    handler(input) {
      // The session's working directory, never permissionRoot: that is the
      // directory this policy module was loaded from (~/.pi/agent/
      // permissions), so using it would anchor the workspace to the install
      // location — real project work would read as outside the tree, and
      // writes into the permissions directory as inside it.
      const root = input.cwd;
      if (!root) {
        return undefined;
      }

      const resolvedRoot = resolvePhysicalPath(root);
      const writeDecision = (lexicalPath: string, toolName: "write" | "edit") => {
        const absolutePath = resolvePhysicalPath(lexicalPath);
        if (!isOutsideWorkspace(absolutePath, resolvedRoot, EXEMPT_PREFIXES)) {
          return undefined;
        }
        logPermissionRequest({
          policy: "workspace scope approval",
          toolName,
          rule: "outside-workspace-write",
          decision: "request",
        });
        return request({
          guidance:
            `This write targets ${absolutePath}, outside the session ` +
            `working tree ${root}. Approve only if the user explicitly ` +
            "named this location and operation. Approval applies only to " +
            "this tool call.",
          approveLabel: "Approve write",
          editLabel: "Edit",
          rejectLabel: "Reject write",
        });
      };

      return matchTool(input.tool, {
        write(tool) {
          return writeDecision(tool.absolutePath, "write");
        },
        edit(tool) {
          return writeDecision(tool.absolutePath, "edit");
        },
        bash(tool) {
          const escapes = findWorkspaceEscapes(
            tool.command, root, HOME, EXEMPT_PREFIXES,
          );
          if (escapes.length === 0) {
            return undefined;
          }
          const shown = [...new Set(escapes.map((e) => e.path))]
            .slice(0, 3)
            .join(", ");
          logPermissionRequest({
            policy: "workspace scope approval",
            toolName: "bash",
            rule: "outside-workspace-path",
            decision: "request",
          });
          return request({
            guidance:
              `This command references paths outside the session working ` +
              `tree ${root} (${shown}). Approve only if the user explicitly ` +
              "asked for work on those locations. Approval applies only to " +
              "this tool call.",
            approveLabel: "Approve command",
            editLabel: "Edit command",
            rejectLabel: "Reject command",
          });
        },
      });
    },
  });
}
