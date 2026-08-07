import {
  matchTool,
  request,
} from "@thurstonsand/pi-permissions";

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
