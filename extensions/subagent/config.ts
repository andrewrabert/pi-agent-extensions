import fs from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE_NAME = "subagent.json";

export type DefaultAgentSetting = {
	name: string;
	filePath: string;
};

export function readDefaultAgent(filePath: string): DefaultAgentSetting | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid subagent config in ${filePath}: expected an object`);
	}
	const defaultAgent = (value as Record<string, unknown>).defaultAgent;
	if (typeof defaultAgent !== "string" || !defaultAgent.trim()) {
		throw new Error(`Invalid subagent config in ${filePath}: defaultAgent must be a non-empty string`);
	}
	return { name: defaultAgent.trim(), filePath };
}

export function findProjectDefaultAgent(cwd: string): DefaultAgentSetting | undefined {
	let current = path.resolve(cwd);
	for (;;) {
		const setting = readDefaultAgent(path.join(current, ".pi", CONFIG_FILE_NAME));
		if (setting) return setting;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function globalConfigPath(agentDir: string): string {
	return path.join(agentDir, CONFIG_FILE_NAME);
}

export async function writeDefaultAgent(filePath: string, name: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify({ defaultAgent: name }, null, 2)}\n`, "utf8");
	await rename(temporaryPath, filePath);
}
