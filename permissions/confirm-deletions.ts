import {
  matchCommand,
  matchTool,
  request,
  type PermissionsAPI,
  type SimpleCommand,
} from "@thurstonsand/pi-permissions";

const approvalGuidance =
  "This operation may delete files, directories, or local work. Approve only " +
  "after reviewing the exact command, resolved targets, tracking status, and " +
  "recovery path. Approval applies only to this tool call.";

// `commands` is readonly on the API's CommandMatch; annotating it mutable
// type-checked only because nothing here writes to it.
const requestForCommands = ({
  commands,
}: {
  commands: readonly SimpleCommand[];
}) =>
  request({
    guidance: approvalGuidance,
    highlight: commands.map((command) => command.span),
    approveLabel: "Approve deletion",
    editLabel: "Edit command",
    rejectLabel: "Reject deletion",
  });

const directDeletion = matchCommand({
  program: ["rm", "rmdir", "unlink", "shred", "trash-put"],
  onMatch: requestForCommands,
});

const gioTrash = matchCommand({
  program: "gio",
  subcommands: ["trash"],
  onMatch: requestForCommands,
});

const findDeletion = matchCommand({
  program: "find",
  where: (command) => command.hasFlag("-delete", "-exec", "-execdir"),
  onMatch: requestForCommands,
});

const gitCleanOrRestore = matchCommand({
  program: "git",
  subcommands: ["clean", "restore"],
  onMatch: requestForCommands,
});

const gitHardReset = matchCommand({
  program: "git",
  subcommands: ["reset"],
  where: (command) => command.hasFlag("--hard"),
  onMatch: requestForCommands,
});

const gitCheckoutDiscard = matchCommand({
  program: "git",
  subcommands: ["checkout"],
  where: (command) =>
    command.hasFlag("-f", "--force") ||
    command.args.some((argument) => argument.text === "--"),
  onMatch: requestForCommands,
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
