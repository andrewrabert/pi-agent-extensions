import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const COMMAND = "bashbert";
const ARGS = ["mcp"];
const DEFAULT_PREFIX = "bashbert_";

type Runtime = {
	client: Client;
	generation: number;
};

type RegisteredTool = {
	piName: string;
	fingerprint: string;
};

function piToolName(prefix: string, mcpName: string): string {
	const normalized = mcpName
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9_-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
	return `${prefix}${normalized || "tool"}`;
}

function toolFingerprint(tool: McpTool): string {
	return JSON.stringify({
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
	});
}

async function listAllTools(client: Client): Promise<McpTool[]> {
	const tools: McpTool[] = [];
	let cursor: string | undefined;
	do {
		const result = await client.listTools(cursor ? { cursor } : undefined);
		tools.push(...result.tools);
		cursor = result.nextCursor;
	} while (cursor);
	return tools;
}

function mcpContentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
				return String(block.text);
			}
			return JSON.stringify(block);
		})
		.join("\n");
}

function isExecutableNotFoundError(error: unknown): boolean {
	let current = error;
	while (current && typeof current === "object") {
		if ("code" in current && current.code === "ENOENT") return true;
		if (
			"message" in current &&
			typeof current.message === "string" &&
			current.message.startsWith("Executable not found in $PATH:")
		) {
			return true;
		}
		current = "cause" in current ? current.cause : undefined;
	}
	return false;
}

export default function bashbertExtension(pi: ExtensionAPI) {
	pi.registerFlag("bashbert-enabled", {
		description: "Enable the bashbert MCP tools",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("bashbert-prefix", {
		description: "Prefix for bashbert MCP tool names",
		type: "string",
		default: DEFAULT_PREFIX,
	});

	let runtime: Runtime | null = null;
	let generation = 0;
	let instructions = "";
	const registered = new Map<string, RegisteredTool>();
	const knownPiNames = new Set<string>();
	const deactivatedPiNames = new Set<string>();

	const removeRegisteredTool = (piName: string): void => {
		deactivatedPiNames.add(piName);
		const unregister = (pi as ExtensionAPI & { unregisterTool?: (name: string) => boolean }).unregisterTool;
		if (unregister?.(piName)) return;
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== piName));
	};

	const clearRegisteredTools = (): void => {
		for (const tool of registered.values()) removeRegisteredTool(tool.piName);
		registered.clear();
	};

	const registerMcpTool = (tool: McpTool, prefix: string, currentGeneration: number): void => {
		const piName = piToolName(prefix, tool.name);
		const fingerprint = toolFingerprint(tool);
		const previous = registered.get(tool.name);
		if (previous?.fingerprint === fingerprint && previous.piName === piName) return;
		if (previous && previous.piName !== piName) removeRegisteredTool(previous.piName);

		const schema =
			tool.inputSchema && typeof tool.inputSchema === "object"
				? tool.inputSchema
				: { type: "object", properties: {} };

		pi.registerTool({
			name: piName,
			label: tool.title ?? tool.name,
			description: tool.description ?? "",
			parameters: Type.Unsafe(schema as never),
			async execute(_toolCallId, params, signal) {
				const active = runtime;
				if (!active || active.generation !== currentGeneration) {
					throw new Error("Bashbert MCP is not connected");
				}

				const result = await active.client.callTool(
					{ name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
					undefined,
					signal ? { signal } : undefined,
				);
				const output = mcpContentText(result.content) || "(empty result)";
				const truncation = truncateHead(output, {
					maxBytes: DEFAULT_MAX_BYTES,
					maxLines: DEFAULT_MAX_LINES,
				});
				let text = truncation.content;
				let fullOutputPath: string | undefined;
				if (truncation.truncated) {
					const dir = await mkdtemp(join(tmpdir(), "pi-bashbert-mcp-"));
					fullOutputPath = join(dir, "output.txt");
					await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath!, output, "utf8"));
					text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
					text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
					text += ` Full output saved to: ${fullOutputPath}]`;
				}
				if (result.isError) throw new Error(text);

				return {
					content: [{ type: "text" as const, text }],
					details: {
						server: "bashbert",
						tool: tool.name,
						...(fullOutputPath ? { fullOutputPath, truncation } : {}),
					},
				};
			},
		});

		if (deactivatedPiNames.delete(piName)) {
			const activeTools = pi.getActiveTools();
			if (!activeTools.includes(piName)) pi.setActiveTools([...activeTools, piName]);
		}
		registered.set(tool.name, { piName, fingerprint });
		knownPiNames.add(piName);
	};

	const syncTools = (tools: McpTool[], prefix: string, currentGeneration: number): void => {
		if (runtime?.generation !== currentGeneration) return;

		const existingPiNames = new Set(
			pi.getAllTools()
				.map((tool) => tool.name)
				.filter((name) => !knownPiNames.has(name)),
		);
		const piNames = new Set<string>();
		for (const tool of tools) {
			const name = piToolName(prefix, tool.name);
			if (piNames.has(name)) throw new Error(`Bashbert MCP tool name collision after normalization: ${name}`);
			if (prefix && existingPiNames.has(name)) throw new Error(`Bashbert MCP tool name collision: ${name}`);
			piNames.add(name);
		}

		const incoming = new Set(tools.map((tool) => tool.name));
		for (const [mcpName, current] of registered) {
			if (incoming.has(mcpName)) continue;
			removeRegisteredTool(current.piName);
			registered.delete(mcpName);
		}
		for (const tool of tools) registerMcpTool(tool, prefix, currentGeneration);
	};

	const stop = async (): Promise<void> => {
		const current = runtime;
		runtime = null;
		instructions = "";
		clearRegisteredTools();
		if (current) await current.client.close();
	};

	pi.on("session_start", async (_event, ctx) => {
		await stop();
		const currentGeneration = ++generation;
		if (pi.getFlag("bashbert-enabled") !== true) return;
		const prefix = (pi.getFlag("bashbert-prefix") as string | undefined) ?? DEFAULT_PREFIX;

		let client: Client;
		let refreshSequence = 0;
		const refreshTools = async (): Promise<void> => {
			const sequence = ++refreshSequence;
			const tools = await listAllTools(client);
			if (sequence !== refreshSequence) return;
			syncTools(tools, prefix, currentGeneration);
		};
		client = new Client(
			{ name: "pi-bashbert-mcp", version: "1.0.0" },
			{
				listChanged: {
					tools: {
						autoRefresh: false,
						onChanged: () => {
							void refreshTools().catch((error) =>
								ctx.ui.notify(`Failed to refresh Bashbert tools: ${String(error)}`, "warning"),
							);
						},
					},
				},
			},
		);
		client.onclose = () => {
			if (runtime?.client !== client) return;
			runtime = null;
			instructions = "";
			clearRegisteredTools();
			ctx.ui.setStatus("bashbert", undefined);
			ctx.ui.notify("Bashbert MCP disconnected", "warning");
		};
		const transport = new StdioClientTransport({ command: COMMAND, args: ARGS, cwd: ctx.cwd, stderr: "inherit" });

		try {
			await client.connect(transport);
			if (currentGeneration !== generation) {
				await client.close();
				return;
			}
			runtime = { client, generation: currentGeneration };
			instructions = client.getInstructions?.() ?? "";
			await refreshTools();
			ctx.ui.setStatus("bashbert", ctx.ui.theme.fg("accent", "bashbert"));
		} catch (error) {
			if (runtime?.client === client) runtime = null;
			try {
				await client.close();
			} catch {}
			clearRegisteredTools();
			if (!isExecutableNotFoundError(error)) throw error;
			ctx.ui.notify(`bashbert unavailable: "${COMMAND}" not found in $PATH`, "warning");
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!instructions) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<bashbert_mcp_instructions>\n${instructions}\n</bashbert_mcp_instructions>`,
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		++generation;
		ctx.ui.setStatus("bashbert", undefined);
		await stop();
	});
}
