import {
  matchTool,
  request,
  type PermissionsAPI,
} from "@thurstonsand/pi-permissions";

import { logPermissionRequest } from "./lib/audit.ts";
import { findEgressCommands } from "./lib/path-matchers.js";

// Outbound transmission is the counterpart of secret-read gating: local
// controls mean little if content can be freely POSTed, pushed, or piped
// off the machine. Requests to localhost stay free so development servers
// and the local model router keep working without prompts.
export default function permissions(api: PermissionsAPI) {
  api.onToolUse({
    name: "outbound transmission approval",
    description:
      "Require per-call approval for commands that send data off the " +
      "machine: uploads, raw network transfers, and git push.",

    handler(input) {
      return matchTool(input.tool, {
        bash(tool) {
          const findings = findEgressCommands(tool.command);
          if (findings.length === 0) {
            return undefined;
          }
          const reasons = [...new Set(findings.map((f) => `${f.program}: ${f.reason}`))]
            .slice(0, 3)
            .join("; ");
          const programs = [...new Set(findings.map((f) => f.program))]
            .slice(0, 3)
            .join(",");
          logPermissionRequest({
            policy: "outbound transmission approval",
            toolName: "bash",
            rule: programs,
            decision: "request",
          });
          return request({
            guidance:
              `This command transmits data off this machine (${reasons}). ` +
              "Approve only after confirming the destination and exactly " +
              "what is being sent. Approval applies only to this tool call.",
            approveLabel: "Approve transmission",
            editLabel: "Edit command",
            rejectLabel: "Reject transmission",
          });
        },
      });
    },
  });
}
