import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const DEFAULT_MAX_CYCLES = 5;
const MAX_ALLOWED_CYCLES = 20;
const DEFAULT_VERIFIER_PROMPT = [
	"Review whether Agent A's output satisfies the main prompt.",
	"Request another cycle only when it would materially improve completeness, correctness, or clarity.",
].join(" ");

type ParsedArgs = {
	agentAPrompt: string;
	verifierPrompt: string;
	maxCycles: number;
	exact: boolean;
};

type VerifierDecision = {
	continue: boolean;
	next_input: string;
	reason?: string;
};

type ChildRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: string | null;
};

type FreshRunResult = {
	output: string;
	mode: "pi-subagents" | "pi-cli";
};

const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

function parseShellishArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaping = false;

	for (const ch of input) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current.length > 0) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}

	if (escaping) current += "\\";
	if (quote) throw new Error(`Unclosed ${quote} quote`);
	if (current.length > 0) args.push(current);
	return args;
}

function usageText(): string {
	return [
		'Usage: /until [--verifier "Verifier prompt"] [--cycles 5] [--exact] "Main prompt"',
		"",
		"Arguments:",
		"  Main prompt                  Required positional prompt for Agent A. Quote it when it contains spaces.",
		"",
		"Flags:",
		"  --verifier, --verifier-prompt TEXT",
		"                               Optional verifier/controller prompt for Agent B.",
		`  --cycles, --max-cycles N     Maximum cycles to run (1-${MAX_ALLOWED_CYCLES}; default ${DEFAULT_MAX_CYCLES}).`,
		"  --exact                      Run exactly the requested cycle count; verifier continue:false is reported but ignored until the final cycle.",
		"  --max-rounds N               Deprecated alias for --cycles.",
	].join("\n");
}

function parseCycleCount(value: string | undefined, flagName: string): number {
	if (!value) throw new Error(`${flagName} requires a number`);
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ALLOWED_CYCLES) {
		throw new Error(`${flagName} must be an integer between 1 and ${MAX_ALLOWED_CYCLES}`);
	}
	return parsed;
}

function parseArgs(rawArgs: string): ParsedArgs {
	const tokens = parseShellishArgs(rawArgs);
	let maxCycles = DEFAULT_MAX_CYCLES;
	let verifierPrompt = DEFAULT_VERIFIER_PROMPT;
	let exact = false;
	const positionals: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--help" || token === "-h") throw new Error(usageText());
		if (token === "--exact") {
			exact = true;
			continue;
		}
		if (token === "--verifier" || token === "--verifier-prompt") {
			const value = tokens[++i];
			if (!value) throw new Error(`${token} requires a prompt`);
			verifierPrompt = value;
			continue;
		}
		if (token.startsWith("--verifier=")) {
			verifierPrompt = token.slice("--verifier=".length);
			if (!verifierPrompt) throw new Error("--verifier requires a prompt");
			continue;
		}
		if (token.startsWith("--verifier-prompt=")) {
			verifierPrompt = token.slice("--verifier-prompt=".length);
			if (!verifierPrompt) throw new Error("--verifier-prompt requires a prompt");
			continue;
		}
		if (token === "--cycles" || token === "--max-cycles" || token === "--max-rounds") {
			maxCycles = parseCycleCount(tokens[++i], token);
			continue;
		}
		if (token.startsWith("--cycles=")) {
			maxCycles = parseCycleCount(token.slice("--cycles=".length), "--cycles");
			continue;
		}
		if (token.startsWith("--max-cycles=")) {
			maxCycles = parseCycleCount(token.slice("--max-cycles=".length), "--max-cycles");
			continue;
		}
		if (token.startsWith("--max-rounds=")) {
			maxCycles = parseCycleCount(token.slice("--max-rounds=".length), "--max-rounds");
			continue;
		}
		positionals.push(token);
	}

	if (positionals.length !== 1) {
		throw new Error(`${usageText()}\n\nExpected exactly one positional main prompt; quote prompts that contain spaces.`);
	}
	return { agentAPrompt: positionals[0]!, verifierPrompt, maxCycles, exact };
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractJsonObject(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) return fenced[1].trim();
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first === -1 || last === -1 || last <= first) return null;
	return text.slice(first, last + 1);
}

function parseVerifierDecision(output: string): VerifierDecision {
	const jsonText = extractJsonObject(output);
	if (!jsonText) throw new Error("Verifier did not return a JSON object");
	const parsed = JSON.parse(jsonText) as Partial<VerifierDecision>;
	if (typeof parsed.continue !== "boolean") throw new Error('Verifier JSON must include boolean field "continue"');
	if (typeof parsed.next_input !== "string") throw new Error('Verifier JSON must include string field "next_input"');
	return {
		continue: parsed.continue,
		next_input: parsed.next_input,
		...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
	};
}

function buildAgentAPrompt(currentInput: string, cycle: number): string {
	return [
		"You are Agent A in a deterministic two-agent verifier loop.",
		"This is a fresh-context child run; do not assume prior cycles except for the current input below.",
		"Complete the current input and return your best standalone output.",
		"Do not ask the parent to launch subagents.",
		"",
		`Cycle: ${cycle}`,
		"",
		"Current input:",
		currentInput,
	].join("\n");
}

function buildAgentBPrompt(
	verifierPrompt: string,
	currentInput: string,
	agentAOutput: string,
	cycle: number,
	maxCycles: number,
	exact: boolean,
): string {
	return [
		"You are Agent B, the verifier/controller in a deterministic two-agent loop.",
		"This is a fresh-context child run. Review Agent A's output against the verifier prompt and decide whether another cycle is needed.",
		"Return exactly one JSON object and no prose/fences:",
		'{"continue":false,"next_input":"","reason":"short reason"}',
		"Rules:",
		"- Set continue=false when the loop should stop in normal (non-exact) mode.",
		"- Set continue=true only when another Agent A cycle is needed and next_input contains the complete prompt for that next Agent A run.",
		"- If this is already the final allowed cycle, set continue=false.",
		"- In exact mode, continue=false is still reported, but the parent will keep running until the requested cycle count is reached.",
		"- In exact mode before the final cycle, include a complete next_input when a different next Agent A prompt is useful.",
		"",
		`Cycle: ${cycle} of ${maxCycles}`,
		`Exact mode: ${exact ? "enabled" : "disabled"}`,
		"",
		"Verifier prompt:",
		verifierPrompt,
		"",
		"Input Agent A received:",
		currentInput,
		"",
		"Agent A output:",
		agentAOutput,
	].join("\n");
}

function runFreshPiChild(prompt: string, cwd: string, role: string): Promise<ChildRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", ["--no-session", "--print", prompt], {
			cwd,
			env: {
				...process.env,
				PI_LOOP_VERIFIER_CHILD: role,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (exitCode, signal) => {
			resolve({ stdout: stripAnsi(stdout).trim(), stderr: stripAnsi(stderr).trim(), exitCode, signal });
		});
	});
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: unknown; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function requestFreshSubagent(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const requestId = randomUUID();
		let started = false;
		let done = false;

		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			unsubStarted?.();
			unsubResponse?.();
			next();
		};

		const unsubStarted = pi.events.on(SLASH_SUBAGENT_STARTED_EVENT, (data: unknown) => {
			if (!data || typeof data !== "object") return;
			if ((data as { requestId?: unknown }).requestId === requestId) started = true;
		});

		const unsubResponse = pi.events.on(SLASH_SUBAGENT_RESPONSE_EVENT, (data: unknown) => {
			if (!data || typeof data !== "object") return;
			const response = data as {
				requestId?: unknown;
				result?: { content?: unknown };
				isError?: boolean;
				errorText?: unknown;
			};
			if (response.requestId !== requestId) return;
			if (response.isError) {
				finish(() => reject(new Error(typeof response.errorText === "string" ? response.errorText : "Subagent failed")));
				return;
			}
			finish(() => resolve(textFromContent(response.result?.content)));
		});

		pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
			requestId,
			ctx,
			params: {
				agent: "delegate",
				task: prompt,
				context: "fresh",
				clarify: false,
				agentScope: "both",
			},
		});

		if (!started) finish(() => resolve(null));
	});
}

async function runFreshAgent(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string, role: string): Promise<FreshRunResult> {
	const subagentOutput = await requestFreshSubagent(pi, ctx, prompt);
	if (subagentOutput !== null) return { output: subagentOutput, mode: "pi-subagents" };

	const child = await runFreshPiChild(prompt, ctx.cwd, role);
	if (child.exitCode !== 0) {
		throw new Error(child.stderr || `pi child exited with ${child.exitCode}`);
	}
	return { output: child.stdout, mode: "pi-cli" };
}

function formatReport(cycles: Array<{ cycle: number; input: string; output: string; decision: VerifierDecision; mode: string }>, stopReason: string): string {
	const lines: string[] = [];
	lines.push("# Until Result");
	lines.push("");
	lines.push(`Cycles completed: ${cycles.length}`);
	lines.push(`Stop reason: ${stopReason}`);
	for (const item of cycles) {
		lines.push("");
		lines.push(`## Cycle ${item.cycle}`);
		lines.push("");
		lines.push("### Agent A input");
		lines.push(item.input);
		lines.push("");
		lines.push("### Agent A output");
		lines.push(item.output || "(empty output)");
		lines.push("");
		lines.push(`Execution mode: ${item.mode}`);
		lines.push("");
		lines.push("### Agent B decision");
		lines.push("```json");
		lines.push(JSON.stringify(item.decision, null, 2));
		lines.push("```");
	}
	return lines.join("\n");
}

export default function loopVerifierExtension(pi: ExtensionAPI) {
	pi.registerCommand("until", {
		description: 'Run a fresh-context Agent A / Agent B verification loop: /until [--verifier "Verifier prompt"] [--cycles 5] [--exact] "Main prompt"',
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			let parsed: ParsedArgs;
			try {
				parsed = parseArgs(rawArgs);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			await ctx.waitForIdle();
			const cycles: Array<{ cycle: number; input: string; output: string; decision: VerifierDecision; mode: string }> = [];
			let currentInput = parsed.agentAPrompt;
			let stoppedByCycleLimit = false;

			for (let cycle = 1; cycle <= parsed.maxCycles; cycle++) {
				let aRun: FreshRunResult;
				try {
					if (ctx.hasUI) ctx.ui.setStatus("until", `cycle ${cycle}/${parsed.maxCycles}: Agent A`);
					aRun = await runFreshAgent(pi, ctx, buildAgentAPrompt(currentInput, cycle), "agent-a");
				} catch (error) {
					ctx.ui.notify(`Agent A failed in cycle ${cycle}: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}

				let bRun: FreshRunResult;
				try {
					if (ctx.hasUI) ctx.ui.setStatus("until", `cycle ${cycle}/${parsed.maxCycles}: Agent B`);
					const bPrompt = buildAgentBPrompt(parsed.verifierPrompt, currentInput, aRun.output, cycle, parsed.maxCycles, parsed.exact);
					bRun = await runFreshAgent(pi, ctx, bPrompt, "agent-b");
				} catch (error) {
					ctx.ui.notify(`Agent B failed in cycle ${cycle}: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}

				let decision: VerifierDecision;
				try {
					decision = parseVerifierDecision(bRun.output);
				} catch (error) {
					ctx.ui.notify(`Agent B decision parse failed in cycle ${cycle}: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}

				cycles.push({ cycle, input: currentInput, output: aRun.output, decision, mode: aRun.mode === bRun.mode ? aRun.mode : `${aRun.mode}/${bRun.mode}` });
				if (cycle === parsed.maxCycles) {
					stoppedByCycleLimit = decision.continue || parsed.exact;
					break;
				}
				if (!parsed.exact && !decision.continue) break;
				currentInput = decision.next_input || currentInput;
			}

			if (ctx.hasUI) ctx.ui.setStatus("until", undefined);
			const finalDecision = cycles.at(-1)?.decision;
			const stopReason = parsed.exact && cycles.length === parsed.maxCycles
				? "exact cycle count reached"
				: stoppedByCycleLimit
					? "cycle limit reached"
					: finalDecision?.reason ?? "verifier returned continue=false";
			const report = formatReport(cycles, stopReason);
			pi.sendMessage({
				customType: "loop-verifier-result",
				content: report,
				display: true,
				details: { cycles: cycles.length, exact: parsed.exact, maxCycles: parsed.maxCycles, stoppedByCycleLimit },
			});
			if (!ctx.hasUI) console.log(report);
		},
	});
}
