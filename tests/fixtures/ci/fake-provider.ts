/**
 * Deterministic in-process provider for the installed-entry CI job.
 *
 * Replays a fixed tool-call script with zero network so CI can drive the
 * fully installed harness end-to-end: a destructive command and a secret
 * read that both get gated and resolve headlessly to a no-UI block, and a
 * benign command that must run. Assertions live in the installed-entry
 * assertion script and read the session event stream -- never model wording.
 *
 * WHY A PROVIDER RATHER THAN A MOCK: the point of the installed-entry job
 * is that nothing between `pi` and the permission hooks is stubbed. The
 * only thing replaced is the thing CI must not depend on -- the network
 * and a real model's non-determinism. Everything downstream of the tool
 * call (tool dispatch, the five permission policies, the audit log, the
 * session event stream) is the real installed harness.
 *
 * THE SCRIPT IS LOAD-BEARING. Calls 1 and 2 both resolve through the SAME
 * arm of the live safety layer, not two different ones:
 *   1. `bash rm -rf ~/harness-ci-nonexistent/x` -- destructive; the
 *      deletion policy GATES it (returns `request()`). The path is
 *      deliberately one that cannot exist: if the gate ever regressed,
 *      the command would run, and it must not be able to destroy
 *      anything when it does.
 *   2. `read ~/.ssh/id_rsa`       -- a secret read; the protected-path /
 *      secret-read policy GATES it too (also `request()`).
 *   3. `bash echo ok`             -- benign; must RUN.
 * With no UI attached, `pi-permissions` converts every `request()` into
 * the same no-UI auto-block, so calls 1 and 2 produce the same shape of
 * result. They differ only in which policy fires -- still worth pinning,
 * since it proves both policies are installed, loaded, and matching on
 * their intended inputs. As of this writing, no policy under
 * `permissions/` ever calls `block()` (verified: `grep -rn "block(" \
 * permissions/*.ts` returns nothing), so this fixture cannot and does not
 * exercise a hard-deny path. Consequence: because every gate here is a
 * `request()`, a policy regressing from a hypothetical `block()` down to
 * `request()` would NOT be caught by this job. What this job does prove
 * is that the installer deployed the policies, Pi loaded them, they match
 * on the intended inputs, and a benign command still runs.
 * Do not change the commands or their order: the CI assertions match on
 * them positionally.
 *
 * STEP SELECTION IS STATELESS. The step is chosen by counting the
 * `toolResult` messages already in the context, not by a module-level
 * counter. A counter would be wrong on any retry, fork, or compaction --
 * the same turn would advance the script. Counting the context makes the
 * provider a pure function of the conversation, so a replayed turn
 * replays the same tool call.
 *
 * CI-only repo tooling: not installed by scripts/install.sh and not
 * listed in config/resources.json. Loaded via
 * `pi -e tests/fixtures/ci/fake-provider.ts`.
 *
 * ZERO NETWORK: this module makes no request of any kind. `baseUrl` and
 * `apiKey` below are present only because a provider that declares models
 * must declare them; the literal key exists so no credential prompt or
 * login flow is ever triggered in a headless run. Neither value is read
 * by `streamFake`.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "harness-ci-fake";
const MODEL_ID = "fake-1";
const DONE_TEXT = "HARNESS-CI-DONE";

const SCRIPT: ReadonlyArray<{ tool: string; args: Record<string, unknown> }> = [
	{ tool: "bash", args: { command: "rm -rf ~/harness-ci-nonexistent/x" } },
	{ tool: "read", args: { path: "~/.ssh/id_rsa" } },
	{ tool: "bash", args: { command: "echo ok" } },
];

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Number of tool results already in the conversation: the script index. */
function completedSteps(context: Context): number {
	return context.messages.filter((message) => message.role === "toolResult").length;
}

export function streamFake(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};

	(async () => {
		try {
			stream.push({ type: "start", partial: output });

			const step = completedSteps(context);
			const scripted = SCRIPT[step];

			if (scripted) {
				const id = `${PROVIDER_ID}-${step + 1}`;
				const toolCall: ToolCall = {
					type: "toolCall",
					id,
					name: scripted.tool,
					arguments: {},
				};
				output.content.push(toolCall);
				const contentIndex = output.content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex, partial: output });

				// A real provider streams the argument JSON in fragments and
				// parses the accumulation. One fragment is the degenerate case
				// of the same contract, and keeps the fixture deterministic.
				const delta = JSON.stringify(scripted.args);
				toolCall.arguments = { ...scripted.args };
				stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
				stream.push({
					type: "toolcall_end",
					contentIndex,
					toolCall: { ...toolCall, arguments: { ...scripted.args } },
					partial: output,
				});

				output.stopReason = "toolUse";
			} else {
				output.content.push({ type: "text", text: "" });
				const contentIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex, partial: output });

				const block = output.content[contentIndex];
				if (block.type === "text") {
					block.text = DONE_TEXT;
				}
				stream.push({ type: "text_delta", contentIndex, delta: DONE_TEXT, partial: output });
				stream.push({ type: "text_end", contentIndex, content: DONE_TEXT, partial: output });

				output.stopReason = "stop";
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function fakeProvider(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		name: "Harness CI Fake",
		// Never dialled: streamFake returns without making a request.
		baseUrl: "https://fake-provider.invalid/v1",
		// Literal, not an env reference, so no credential prompt can fire.
		apiKey: "harness-ci-fake-no-network",
		api: "harness-ci-fake-api",
		models: [
			{
				id: MODEL_ID,
				name: "Fake 1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: streamFake,
	});
}
