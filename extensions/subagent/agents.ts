/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "package" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

const packageAgentDirs = new Set<string>();

export function registerPackageAgentDir(dir: string): void {
	packageAgentDirs.add(path.resolve(dir));
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let frontmatter: Record<string, string>;
		let body: string;
		try {
			({ frontmatter, body } = parseFrontmatter<Record<string, string>>(content));
		} catch {
			continue;
		}

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const toolsField = frontmatter.tools?.trim();
		const tools =
			toolsField === "none"
				? []
				: toolsField
					? toolsField
							.split(",")
							.map((t: string) => t.trim())
							.filter(Boolean)
					: undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function parseAgentNames(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

export function filterAgents(
	agents: AgentConfig[],
	options: { agents?: string[]; noAgents: boolean; excludeAgents?: string[] },
): AgentConfig[] {
	const allowed = options.agents ? new Set(options.agents) : undefined;
	const excluded = options.excludeAgents ? new Set(options.excludeAgents) : undefined;
	return agents.filter(
		(agent) => (allowed ? allowed.has(agent.name) : !options.noAgents) && !excluded?.has(agent.name),
	);
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const packageAgents =
		scope === "project"
			? []
			: Array.from(packageAgentDirs).flatMap((dir) => loadAgentsFromDir(dir, "package"));
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	for (const agent of packageAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

export function formatAvailableAgentsPrompt(agents: AgentConfig[]): string {
	const entries = agents.map((agent) => {
		const tools = agent.tools === undefined ? "default" : agent.tools.length > 0 ? agent.tools.join(", ") : "none";
		return `- ${agent.name}: ${agent.description} (tools: ${tools})`;
	});
	return [
		"<available_subagents>",
		"Use the subagent tool with one of these exact agent names. Do not invent or alter a name.",
		...(entries.length > 0 ? entries : ["none"]),
		"</available_subagents>",
	].join("\n");
}
