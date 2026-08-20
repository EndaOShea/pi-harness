import {
  matchCommand,
  matchTool,
  request,
  type PermissionsAPI,
  type SimpleCommand,
} from "@thurstonsand/pi-permissions";

import { logPermissionRequest } from "./lib/audit.ts";

const approvalGuidance =
  "This operation may delete files, directories, or local work. Approve only " +
  "after reviewing the exact command, resolved targets, tracking status, and " +
  "recovery path. Approval applies only to this tool call.";

// `commands` is readonly on the API's CommandMatch; annotating it mutable
// type-checked only because nothing here writes to it.
// `rule` is a policy-defined identifier for the matched destructive pattern
// (never derived from the matched command text), so it is safe to audit.
const requestForRule = (rule: string) => ({
  commands,
}: {
  commands: readonly SimpleCommand[];
}) => {
  logPermissionRequest({
    policy: "direct deletion approval",
    toolName: "bash",
    rule,
    decision: "request",
  });
  return request({
    guidance: approvalGuidance,
    highlight: commands.map((command) => command.span),
    approveLabel: "Approve deletion",
    editLabel: "Edit command",
    rejectLabel: "Reject deletion",
  });
};

const directDeletion = matchCommand({
  program: ["rm", "rmdir", "unlink", "shred", "trash-put"],
  onMatch: requestForRule("rm,rmdir,unlink,shred,trash-put"),
});

const gioTrash = matchCommand({
  program: "gio",
  subcommands: ["trash"],
  onMatch: requestForRule("gio trash"),
});

const findDeletion = matchCommand({
  program: "find",
  where: (command) => command.hasFlag("-delete", "-exec", "-execdir"),
  onMatch: requestForRule("find -delete,-exec,-execdir"),
});

const gitCleanOrRestore = matchCommand({
  program: "git",
  subcommands: ["clean", "restore"],
  onMatch: requestForRule("git clean,restore"),
});

const gitHardReset = matchCommand({
  program: "git",
  subcommands: ["reset"],
  where: (command) => command.hasFlag("--hard"),
  onMatch: requestForRule("git reset --hard"),
});

const gitCheckoutDiscard = matchCommand({
  program: "git",
  subcommands: ["checkout"],
  where: (command) =>
    command.hasFlag("-f", "--force") ||
    command.args.some((argument) => argument.text === "--"),
  onMatch: requestForRule("git checkout --force"),
});

export default function permissions(api: PermissionsAPI) {
  api.onToolUse({
    name: "direct deletion approval",
    description:
      "Require per-call approval before direct or Git-based filesystem " +
      "deletion.",

    handler(input) {
      return matchTool(input.tool, {
        async bash(tool) {
          const matchers = [
            directDeletion,
            gioTrash,
            findDeletion,
            gitCleanOrRestore,
            gitHardReset,
            gitCheckoutDiscard,
          ];
          for (const matcher of matchers) {
            const decision = await matcher(tool);
            if (decision) {
              return decision;
            }
          }
        },
      });
    },
  });
}
