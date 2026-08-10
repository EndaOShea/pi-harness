import { homedir } from "node:os";

import {
  matchTool,
  request,
  type PermissionsAPI,
} from "@thurstonsand/pi-permissions";

import {
  findWorkspaceEscapes,
  isOutsideWorkspace,
} from "./lib/path-matchers.js";

// The session's working tree is the workspace boundary: file-tool writes
// and shell path references outside it require per-call approval. Reads
// stay ungated here — secret-shaped reads are covered by the
// protected-paths policy. OS scratch space and read-only pseudo-
// filesystems stay usable without prompts.
const EXEMPT_PREFIXES = ["/tmp", "/var/tmp", "/dev", "/proc", "/sys"];

const HOME = homedir();

export default function permissions(api: PermissionsAPI) {
  api.onToolUse({
    name: "workspace scope approval",
    description:
      "Require per-call approval for file-tool writes and shell path " +
      "references outside the session's working tree.",

    handler(input) {
      const root = input.permissionRoot ?? input.cwd;
      if (!root) {
        return undefined;
      }

      const writeDecision = (absolutePath: string) => {
        if (!isOutsideWorkspace(absolutePath, root, EXEMPT_PREFIXES)) {
          return undefined;
        }
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
          return writeDecision(tool.absolutePath);
        },
        edit(tool) {
          return writeDecision(tool.absolutePath);
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
