import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	DefaultResourceLoader,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
	createAgentSession,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents, registerPackageAgentDir } from "./agents.ts";
import { resolveToolPatterns } from "./tool-patterns.ts";

const CHILD_METADATA_TYPE = "subagent-session";

type ChildState = "running" | "completed" | "failed" | "stopped";

type ChildMetadata = {
	agent: string;
	cwd: string;
};

type ChildHandle = ChildMetadata & {
	id: string;
	sessionFile: string;
	sessionManager: SessionManager;
	session?: AgentSession;
	state: ChildState;
	queue: string[];
	worker?: Promise<void>;
	stopRequested: boolean;
	closing: boolean;
};

type AsyncSubagentEvent =
	| { type: "subagent_completed"; agentId: string; output: string }
	| { type: "subagent_failed"; agentId: string; error: string };

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function childSessionDir(parentFile: string, parentId: string): string {
	return path.join(path.dirname(parentFile), parentId);
}

function createChildSessionManager(
	cwd: string,
	dir: string,
	parentFile: string,
	metadata: ChildMetadata,
): SessionManager {
	const initial = SessionManager.create(cwd, dir, { parentSession: parentFile });
	initial.appendCustomEntry(CHILD_METADATA_TYPE, metadata);
	const sessionFile = initial.getSessionFile();
	const header = initial.getHeader();
	if (!sessionFile || !header) throw new Error("Failed to create persistent child session");

	// SessionManager normally waits for the first assistant response before creating
	// the file. Persist the identity and metadata now so a failed startup remains
	// resumable/discoverable, then reopen to synchronize SessionManager's flush state.
	const jsonl = [header, ...initial.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	fs.writeFileSync(sessionFile, jsonl, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return SessionManager.open(sessionFile, dir);
}

function childMetadata(sessionManager: SessionManager): ChildMetadata | undefined {
	for (const entry of sessionManager.getEntries().toReversed()) {
		if (entry.type !== "custom" || entry.customType !== CHILD_METADATA_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") return undefined;
		const agent = "agent" in data ? data.agent : undefined;
		const cwd = "cwd" in data ? data.cwd : undefined;
		if (typeof agent === "string" && typeof cwd === "string") return { agent, cwd };
		return undefined;
	}
	return undefined;
}

function finalAssistant(messages: AgentMessage[]): Extract<AgentMessage, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function assistantText(message: Extract<AgentMessage, { role: "assistant" }> | undefined): string {
	if (!message) return "";
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const SubagentParams = Type.Object({
	agent: Type.String({ description: "Name of the agent to start." }),
	prompt: Type.String({ description: "Initial instruction for the agent." }),
});

const SubagentSendParams = Type.Object({
	to: Type.String({ description: "Agent ID." }),
	message: Type.String({ description: "Message for the agent." }),
});

const SubagentStopParams = Type.Object({
	to: Type.String({ description: "Agent ID." }),
});

export default function subagentExtension(pi: ExtensionAPI) {
	let mainAgent: AgentConfig | undefined;
	let toolsBeforeMainAgent: string[] | undefined;
	const children = new Map<string, ChildHandle>();

	const unregisterPackageAgentPathListener = pi.events.on(
		"subagent:register-agent-path",
		(data: unknown) => {
			if (!data || typeof data !== "object" || !("path" in data) || typeof data.path !== "string") return;
			registerPackageAgentDir(data.path);
		},
	);

	const requireParent = (ctx: ExtensionContext): { file: string; id: string; dir: string } => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) throw new Error("Persistent subagents require a persisted parent session");
		const id = ctx.sessionManager.getSessionId();
		return { file, id, dir: childSessionDir(file, id) };
	};

	const emitAsyncEvent = (event: AsyncSubagentEvent): void => {
		try {
			pi.sendMessage(
				{
					customType: event.type,
					content: JSON.stringify([event]),
					display: true,
					details: event,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// The parent may have switched sessions while a child was finishing.
		}
	};

	const resolveAgent = (handle: ChildHandle): AgentConfig => {
		const agent = discoverAgents(handle.cwd, "user").agents.find((candidate) => candidate.name === handle.agent);
		if (!agent) throw new Error(`Unknown agent: "${handle.agent}"`);
		return agent;
	};

	const openChildSession = async (handle: ChildHandle, ctx: ExtensionContext): Promise<AgentSession> => {
		if (handle.session) return handle.session;
		const agent = resolveAgent(handle);
		const availableTools = pi.getAllTools().map((tool) => tool.name);
		const resolution = agent.tools ? resolveToolPatterns(agent.tools, availableTools) : undefined;
		if (resolution && resolution.unmatched.length > 0) {
			throw new Error(
				`Agent "${agent.name}" requires unavailable tools or patterns: ${resolution.unmatched.join(", ")}`,
			);
		}

		const settingsManager = SettingsManager.create(handle.cwd, getAgentDir());
		const resourceLoader = new DefaultResourceLoader({
			cwd: handle.cwd,
			agentDir: getAgentDir(),
			settingsManager,
			appendSystemPrompt: agent.systemPrompt.trim() ? [agent.systemPrompt] : [],
		});
		await resourceLoader.reload();

		let model;
		if (handle.sessionManager.getEntries().every((entry) => entry.type !== "model_change") && agent.model) {
			const separator = agent.model.indexOf("/");
			model =
				separator > 0
					? ctx.modelRegistry.find(agent.model.slice(0, separator), agent.model.slice(separator + 1))
					: ctx.modelRegistry.getAvailable().find((candidate) => candidate.id === agent.model);
			if (!model) throw new Error(`Agent "${agent.name}" model not found: ${agent.model}`);
		}

		const { session } = await createAgentSession({
			cwd: handle.cwd,
			agentDir: getAgentDir(),
			model,
			tools: resolution?.tools,
			resourceLoader,
			sessionManager: handle.sessionManager,
			settingsManager,
		});
		await session.bindExtensions({ mode: "print" });
		handle.session = session;
		return session;
	};

	const runQueue = (handle: ChildHandle, ctx: ExtensionContext): void => {
		if (handle.worker || handle.closing) return;
		handle.worker = (async () => {
			try {
				const session = await openChildSession(handle, ctx);
				while (handle.queue.length > 0) {
					const prompt = handle.queue.shift()!;
					handle.state = "running";
					handle.stopRequested = false;
					try {
						await session.prompt(prompt);
						if (handle.stopRequested) {
							handle.state = "stopped";
							continue;
						}
						const assistant = finalAssistant(session.messages);
						if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") {
							handle.state = "failed";
							handle.queue.length = 0;
							emitAsyncEvent({
								type: "subagent_failed",
								agentId: handle.id,
								error: assistant.errorMessage || `Agent stopped: ${assistant.stopReason}`,
							});
							continue;
						}
						handle.state = "completed";
						emitAsyncEvent({
							type: "subagent_completed",
							agentId: handle.id,
							output: assistantText(assistant) || "(no output)",
						});
					} catch (error) {
						if (handle.stopRequested) {
							handle.state = "stopped";
							continue;
						}
						handle.state = "failed";
						handle.queue.length = 0;
						emitAsyncEvent({ type: "subagent_failed", agentId: handle.id, error: errorText(error) });
					}
				}
			} catch (error) {
				handle.state = "failed";
				handle.queue.length = 0;
				emitAsyncEvent({ type: "subagent_failed", agentId: handle.id, error: errorText(error) });
			} finally {
				handle.worker = undefined;
			}
		})();
	};

	const restoreChildren = (ctx: ExtensionContext): void => {
		children.clear();
		const parentFile = ctx.sessionManager.getSessionFile();
		if (!parentFile) return;
		const dir = childSessionDir(parentFile, ctx.sessionManager.getSessionId());
		if (!fs.existsSync(dir)) return;

		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const sessionFile = path.join(dir, entry.name);
			try {
				const sessionManager = SessionManager.open(sessionFile, dir);
				if (sessionManager.getHeader()?.parentSession !== parentFile) continue;
				const metadata = childMetadata(sessionManager);
				if (!metadata) continue;
				const assistant = finalAssistant(sessionManager.buildSessionContext().messages);
				const state: ChildState =
					assistant?.stopReason === "error" || assistant?.stopReason === "aborted" ? "failed" : "completed";
				const handle: ChildHandle = {
					...metadata,
					id: sessionManager.getSessionId(),
					sessionFile,
					sessionManager,
					state,
					queue: [],
					stopRequested: false,
					closing: false,
				};
				children.set(handle.id, handle);
			} catch {
				// Ignore unrelated or incomplete files in the private child directory.
			}
		}
	};

	const closeChild = async (handle: ChildHandle): Promise<void> => {
		handle.closing = true;
		handle.stopRequested = true;
		handle.queue.length = 0;
		try {
			await handle.session?.abort();
		} catch {
			// Continue shutdown even if abort hooks fail.
		}
		try {
			await handle.worker;
		} catch {
			// The worker reports its own failure before settling.
		}
		if (handle.session) {
			try {
				await handle.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} catch {
				// Best-effort shutdown; dispose below is unconditional.
			}
			handle.session.dispose();
			handle.session = undefined;
		}
		handle.state = "stopped";
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Start a persistent background subagent. Returns its Pi-generated agentId immediately; completion or failure arrives later as an asynchronous context message. Use subagent_send with that agentId to continue the same conversation and subagent_stop to abort its current run.",
		promptSnippet: "Start a persistent background agent and receive its result asynchronously",
		promptGuidelines: [
			"Use subagent to start specialized background work. Keep its returned agentId when the conversation may need to continue.",
			"Subagent completion and failure arrive asynchronously; do not treat the immediate start response as the agent's final output.",
		],
		parameters: SubagentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const parent = requireParent(ctx);
			const agent = discoverAgents(ctx.cwd, "user").agents.find((candidate) => candidate.name === params.agent);
			if (!agent) {
				const available = discoverAgents(ctx.cwd, "user").agents.map((candidate) => candidate.name).join(", ") || "none";
				throw new Error(`Unknown agent: "${params.agent}". Available agents: ${available}`);
			}

			const sessionManager = createChildSessionManager(ctx.cwd, parent.dir, parent.file, {
				agent: agent.name,
				cwd: ctx.cwd,
			});
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Failed to create persistent child session");

			const handle: ChildHandle = {
				id: sessionManager.getSessionId(),
				agent: agent.name,
				cwd: ctx.cwd,
				sessionFile,
				sessionManager,
				state: "running",
				queue: [params.prompt],
				stopRequested: false,
				closing: false,
			};
			children.set(handle.id, handle);
			runQueue(handle, ctx);
			return {
				content: [{ type: "text", text: JSON.stringify({ agentId: handle.id }) }],
				details: { agentId: handle.id, sessionFile },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent)}\n  ${theme.fg("dim", args.prompt)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { agentId?: string } | undefined;
			return new Text(theme.fg("muted", details?.agentId ? `started ${details.agentId}` : "failed to start"), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Subagent Send",
		description: "Continue an existing persistent subagent conversation by sending a message to its Pi-generated agentId. A running agent is steered; a completed agent starts another run. The next completion or failure arrives asynchronously.",
		promptSnippet: "Continue a running or completed subagent by agentId",
		promptGuidelines: [
			"Use subagent_send with the original agentId when follow-up work needs the same subagent context; do not start a replacement agent.",
		],
		parameters: SubagentSendParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			requireParent(ctx);
			const handle = children.get(params.to);
			if (!handle) throw new Error(`Unknown subagent: ${params.to}`);
			if (handle.state !== "running" && handle.state !== "completed") {
				throw new Error(`Subagent is ${handle.state}: ${params.to}`);
			}
			if (handle.state === "running" && handle.session?.isStreaming) {
				try {
					await handle.session.steer(params.message);
				} catch {
					// The run may have settled between the state check and steer.
					handle.queue.push(params.message);
					runQueue(handle, ctx);
				}
			} else {
				handle.state = "running";
				handle.queue.push(params.message);
				runQueue(handle, ctx);
			}
			return {
				content: [{ type: "text", text: JSON.stringify({ agentId: handle.id }) }],
				details: { agentId: handle.id, sessionFile: handle.sessionFile },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_send "))}${theme.fg("accent", args.to)}\n  ${theme.fg("dim", args.message)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { agentId?: string } | undefined;
			return new Text(theme.fg("muted", details?.agentId ? `sent to ${details.agentId}` : "send failed"), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Abort a persistent subagent's current run by its Pi-generated agentId. Its transcript remains stored, but a stopped run cannot be continued with subagent_send.",
		promptSnippet: "Abort a subagent's current run by agentId",
		promptGuidelines: ["Use subagent_stop only to abort work that should no longer continue."],
		parameters: SubagentStopParams,
		async execute(_toolCallId, params) {
			const handle = children.get(params.to);
			if (!handle) throw new Error(`Unknown subagent: ${params.to}`);
			if (handle.state === "running") {
				handle.stopRequested = true;
				handle.queue.length = 0;
				await handle.session?.abort();
				handle.state = "stopped";
			}
			return {
				content: [{ type: "text", text: JSON.stringify({ agentId: handle.id }) }],
				details: { agentId: handle.id, sessionFile: handle.sessionFile },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_stop "))}${theme.fg("accent", args.to)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { agentId?: string } | undefined;
			return new Text(theme.fg("muted", details?.agentId ? `stopped ${details.agentId}` : "stop failed"), 0, 0);
		},
	});

	pi.registerMessageRenderer("subagent_completed", (message, _options, theme) =>
		new Text(theme.fg("success", message.content as string), 0, 0),
	);
	pi.registerMessageRenderer("subagent_failed", (message, _options, theme) =>
		new Text(theme.fg("error", message.content as string), 0, 0),
	);

	const installAgentFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					let pwd = ctx.sessionManager.getCwd();
					const home = os.homedir();
					const relativeToHome = path.relative(home, pwd);
					if (relativeToHome === "" || (!relativeToHome.startsWith(`..${path.sep}`) && relativeToHome !== "..")) {
						pwd = relativeToHome === "" ? "~" : `~${path.sep}${relativeToHome}`;
					}
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd += ` • ${sessionName}`;
					const agent = mainAgent ? truncateToWidth(theme.bg("selectedBg", ` ${mainAgent.name} `), width, "") : "";
					const availablePwd = Math.max(0, width - visibleWidth(agent) - (agent ? 1 : 0));
					const displayedPwd = availablePwd ? truncateToWidth(theme.fg("dim", pwd), availablePwd, theme.fg("dim", "...")) : "";
					const padding = " ".repeat(Math.max(0, width - visibleWidth(displayedPwd) - visibleWidth(agent)));
					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const left = `${context?.tokens != null ? formatTokens(context.tokens) : "?"}/${formatTokens(contextWindow)}`;
					const modelName = ctx.model?.id ?? "no-model";
					const right = ctx.model?.reasoning ? `${modelName} • ${ctx.thinkingLevel === "off" ? "thinking off" : ctx.thinkingLevel}` : modelName;
					const statusPadding = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [
						truncateToWidth(displayedPwd + padding + agent, width),
						truncateToWidth(theme.fg("dim", left + statusPadding + right), width),
					];
				},
			};
		});
	};

	const activateMainAgent = async (agent: AgentConfig, ctx: ExtensionContext) => {
		if (!agent.tools) throw new Error(`Main agent "${agent.name}" must declare a tools allowlist or tools: none`);
		const resolution = resolveToolPatterns(agent.tools, pi.getAllTools().map((tool) => tool.name));
		if (resolution.unmatched.length > 0) {
			throw new Error(`Main agent "${agent.name}" requires unavailable tools or patterns: ${resolution.unmatched.join(", ")}`);
		}
		if (agent.model) {
			const separator = agent.model.indexOf("/");
			const model = separator > 0
				? ctx.modelRegistry.find(agent.model.slice(0, separator), agent.model.slice(separator + 1))
				: ctx.modelRegistry.getAvailable().find((candidate) => candidate.id === agent.model);
			if (!model) throw new Error(`Main agent "${agent.name}" model not found: ${agent.model}`);
			if (!(await pi.setModel(model))) throw new Error(`Main agent "${agent.name}" model is unavailable: ${agent.model}`);
		}
		toolsBeforeMainAgent ??= pi.getActiveTools();
		mainAgent = agent;
		pi.setActiveTools(resolution.tools);
		ctx.ui.setStatus("main-agent", `agent:${agent.name}`);
	};

	const deactivateMainAgent = (ctx: ExtensionContext) => {
		mainAgent = undefined;
		if (toolsBeforeMainAgent) pi.setActiveTools(toolsBeforeMainAgent);
		ctx.ui.setStatus("main-agent", undefined);
	};

	pi.registerFlag("agent", {
		description: `Run a user agent from ${path.join(getAgentDir(), "agents")} as the main pi agent`,
		type: "string",
	});

	let handleAgentCommand!: (args: string, ctx: ExtensionContext) => Promise<void>;
	pi.registerCommand("agent", {
		description: "Switch or unload the main pi agent for the current session",
		handler: (handleAgentCommand = async (args, ctx) => {
			const agents = discoverAgents(ctx.cwd, "user").agents.sort((a, b) => a.name.localeCompare(b.name));
			let name = args.trim();
			if (!name) {
				const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
					const items: SelectItem[] = [
						{ value: "default", label: "default", description: "Use pi without a main agent." },
						...agents.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description })),
					];
					const container = new Container();
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					container.addChild(new Text(theme.fg("accent", theme.bold("Switch main agent"))));
					const selectList = new SelectList(items, Math.min(items.length, 10), {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					});
					selectList.onSelect = (item) => done(item.value);
					selectList.onCancel = () => done(null);
					container.addChild(selectList);
					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
					};
				});
				if (!selected) return;
				name = selected;
			}
			if (name === "default") {
				deactivateMainAgent(ctx);
				ctx.ui.notify("Switched main agent to default", "info");
				return;
			}
			const agent = agents.find((candidate) => candidate.name === name);
			if (!agent) {
				ctx.ui.notify(`Unknown user agent: "${name}"`, "error");
				return;
			}
			try {
				if (mainAgent?.name === agent.name) {
					deactivateMainAgent(ctx);
					ctx.ui.notify(`Unloaded main agent ${agent.name}`, "info");
					return;
				}
				await activateMainAgent(agent, ctx);
				ctx.ui.notify(`Switched main agent to ${agent.name}`, "info");
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
			}
		}),
	});

	pi.registerCommand("subagents", {
		description: "Open a running subagent in a new tmux pane",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			if (!process.env.TMUX) {
				ctx.ui.notify("/subagents requires tmux", "error");
				return;
			}
			const running = Array.from(children.values()).filter((handle) => handle.state === "running");
			if (running.length === 0) {
				ctx.ui.notify("No running subagents.", "info");
				return;
			}

			const items: SelectItem[] = running.map((handle) => ({
				value: handle.id,
				label: `${handle.agent}  ${handle.id.slice(0, 8)}…`,
			}));

			const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Open running subagent in tmux"))));
				const selectList = new SelectList(items, Math.min(items.length, 12), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});
			if (!selected) return;

			const handle = children.get(selected);
			if (!handle || handle.state !== "running") {
				ctx.ui.notify("That subagent is no longer running.", "info");
				return;
			}

			await closeChild(handle);
			const result = await pi.exec("tmux", [
				"split-window",
				"-h",
				"-c",
				handle.cwd,
				"--",
				"pi",
				"--session",
				handle.sessionFile,
				"--agent",
				handle.agent,
			]);
			if (result.code !== 0) {
				ctx.ui.notify(result.stderr.trim() || "Failed to open tmux pane", "error");
			}
		},
	});

	pi.registerShortcut("alt+o", {
		description: "Open the main agent selector",
		handler: (ctx) => handleAgentCommand("", ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		installAgentFooter(ctx);
		restoreChildren(ctx);
		const requested = pi.getFlag("agent");
		if (typeof requested !== "string" || !requested.trim()) {
			deactivateMainAgent(ctx);
			return;
		}
		const agent = discoverAgents(ctx.cwd, "user").agents.find((candidate) => candidate.name === requested.trim());
		if (!agent) throw new Error(`Unknown user agent: "${requested.trim()}"`);
		await activateMainAgent(agent, ctx);
	});

	pi.on("before_agent_start", (event) => {
		if (!mainAgent) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<main_agent name="${mainAgent.name}">\n${mainAgent.systemPrompt.trim()}\n</main_agent>`,
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		unregisterPackageAgentPathListener();
		await Promise.all(Array.from(children.values(), closeChild));
		children.clear();
		ctx.ui.setStatus("main-agent", undefined);
		ctx.ui.setFooter(undefined);
	});
}
