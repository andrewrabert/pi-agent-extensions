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

const COMMAND = process.env.NOTED_COMMAND ?? "noted";
const ARGS = ["server", "mcp"];

type Runtime = {
	client: Client;
	generation: number;
};

type RegisteredTool = {
	piName: string;
	fingerprint: string;
};

function inheritedEnvironment(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
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

function piToolName(mcpName: string): string {
	const snakeCase = mcpName
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9_-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
	return `noted_${snakeCase || "tool"}`;
}

function toolFingerprint(tool: McpTool): string {
	return JSON.stringify({
		name: tool.name,
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

function mcpTextContent(content: unknown): string {
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

export default function notedMcpExtension(pi: ExtensionAPI) {
	pi.registerFlag("no-noted", {
		description: "Disable noted tools",
		type: "boolean",
		default: false,
	});

	let runtime: Runtime | null = null;
	let generation = 0;
	let instructions = "";
	const registered = new Map<string, RegisteredTool>();

	const removeRegisteredTool = (piName: string): void => {
		const unregister = (pi as ExtensionAPI & { unregisterTool?: (name: string) => boolean }).unregisterTool;
		if (unregister?.(piName)) return;
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== piName));
	};

	const registerMcpTool = (tool: McpTool, currentGeneration: number): void => {
		const piName = piToolName(tool.name);
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
			label: `Noted: ${tool.title ?? tool.name}`,
			description: tool.description ?? "",
			parameters: Type.Unsafe(schema as never),
			async execute(_toolCallId, params, signal) {
				const active = runtime;
				if (!active || active.generation !== currentGeneration) {
					throw new Error("Noted MCP is not connected");
				}

				const result = await active.client.callTool(
					{ name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
					undefined,
					signal ? { signal } : undefined,
				);
				const output = mcpTextContent(result.content) || "(empty result)";

				if (result.isError) throw new Error(output);

				const truncation = truncateHead(output, {
					maxBytes: DEFAULT_MAX_BYTES,
					maxLines: DEFAULT_MAX_LINES,
				});
				let text = truncation.content;
				let fullOutputPath: string | undefined;

				if (truncation.truncated) {
					const dir = await mkdtemp(join(tmpdir(), "pi-noted-mcp-"));
					fullOutputPath = join(dir, "output.txt");
					await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath!, output, "utf8"));
					text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
					text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
					text += ` Full output saved to: ${fullOutputPath}]`;
				}

				return {
					content: [{ type: "text" as const, text }],
					details: {
						server: "noted",
						tool: tool.name,
						...(fullOutputPath ? { fullOutputPath, truncation } : {}),
					},
				};
			},
		});

		registered.set(tool.name, { piName, fingerprint });
	};

	const syncTools = (tools: McpTool[], currentGeneration: number): void => {
		if (runtime?.generation !== currentGeneration) return;

		const incoming = new Set(tools.map((tool) => tool.name));
		for (const [mcpName, current] of registered) {
			if (incoming.has(mcpName)) continue;
			removeRegisteredTool(current.piName);
			registered.delete(mcpName);
		}

		const piNames = new Set<string>();
		for (const tool of tools) {
			const name = piToolName(tool.name);
			if (piNames.has(name)) throw new Error(`Noted MCP tool name collision after normalization: ${name}`);
			piNames.add(name);
			registerMcpTool(tool, currentGeneration);
		}
	};

	const stop = async (): Promise<void> => {
		const current = runtime;
		runtime = null;
		instructions = "";
		if (current) await current.client.close();
	};

	pi.on("session_start", async (_event, ctx) => {
		await stop();
		const currentGeneration = ++generation;
		if (pi.getFlag("no-noted") === true) return;

		let client: Client;
		client = new Client(
			{ name: "pi-noted-mcp", version: "1.0.0" },
			{
				listChanged: {
					tools: {
						onChanged: (error, tools) => {
							if (error || !tools || runtime?.client !== client) return;
							syncTools(tools, currentGeneration);
						},
					},
				},
			},
		);

		const transport = new StdioClientTransport({
			command: COMMAND,
			args: ARGS,
			cwd: ctx.cwd,
			env: { ...inheritedEnvironment(), NOTED_LOG_LEVEL: "WARN" },
			stderr: "inherit",
		});

		try {
			await client.connect(transport);
			if (currentGeneration !== generation) {
				await client.close();
				return;
			}

			runtime = { client, generation: currentGeneration };
			instructions = client.getInstructions?.() ?? "";
			const tools = await listAllTools(client);
			syncTools(tools, currentGeneration);
		} catch (error) {
			if (runtime?.client === client) runtime = null;
			try {
				await client.close();
			} catch {
			}
			if (!isExecutableNotFoundError(error)) throw error;
			ctx.ui.notify(`noted unavailable: "${COMMAND}" not found in $PATH`, "warning");
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!instructions) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<noted_mcp_instructions>\n${instructions}\n</noted_mcp_instructions>`,
		};
	});

	pi.on("session_shutdown", async () => {
		++generation;
		await stop();
	});
}
