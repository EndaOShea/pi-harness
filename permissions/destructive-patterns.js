import {
  matchTool,
  request,
} from "@thurstonsand/pi-permissions";

import { logPermissionRequest } from "./lib/audit.ts";
import { findDestructiveFallbacks } from "./lib/destructive-patterns.js";

const approvalGuidance =
  "This operation may delete files, directories, or local work through an " +
  "interpreter or shell construct. Approve only after reviewing the exact " +
  "command, resolved targets, tracking status, and recovery path. Approval " +
  "applies only to this tool call.";

export default function permissions(api) {
  api.onToolUse({
    name: "indirect deletion approval",
    description:
      "Require per-call approval for interpreter-driven, xargs-based, or " +
      "truncating filesystem operations.",

    handler(input) {
      return matchTool(input.tool, {
        bash(tool) {
          const fallbacks = findDestructiveFallbacks(tool.command);
          if (fallbacks.length === 0) {
            return;
          }

          // Every `name` is a constant defined in lib/destructive-patterns.js
          // ("xargs deletion", "dd overwrite"), never derived from the matched
          // command text, so the joined identifier is safe to audit — the same
          // argument confirm-deletions.ts makes for its rule strings.
          logPermissionRequest({
            policy: "indirect deletion approval",
            toolName: "bash",
            rule: fallbacks.map(({ name }) => name).join(","),
            decision: "request",
          });
          return request({
            guidance:
              `${approvalGuidance}\n\nDetected fallback patterns:\n` +
              fallbacks.map(({ name }) => `- ${name}`).join("\n"),
            highlight: fallbacks.map(({ pattern }) => pattern),
            approveLabel: "Approve deletion",
            editLabel: "Edit command",
            rejectLabel: "Reject deletion",
          });
        },
      });
    },
  });
}
