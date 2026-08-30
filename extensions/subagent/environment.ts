import type { AgentEnvironment } from "./agents.ts";

export function applyAgentEnvironment(
	base: NodeJS.ProcessEnv,
	overrides: AgentEnvironment,
): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const [name, value] of Object.entries(overrides)) {
		if (value === null) delete env[name];
		else env[name] = value;
	}
	return env;
}

export class AgentEnvironmentOverlay {
	private readonly inherited: NodeJS.ProcessEnv;
	private readonly target: NodeJS.ProcessEnv;
	private activeNames = new Set<string>();

	constructor(target: NodeJS.ProcessEnv) {
		this.target = target;
		this.inherited = { ...target };
	}

	apply(overrides: AgentEnvironment | undefined): void {
		this.restore();
		if (!overrides) return;
		for (const [name, value] of Object.entries(overrides)) {
			this.activeNames.add(name);
			if (value === null) delete this.target[name];
			else this.target[name] = value;
		}
	}

	restore(): void {
		for (const name of this.activeNames) {
			const value = this.inherited[name];
			if (value === undefined) delete this.target[name];
			else this.target[name] = value;
		}
		this.activeNames.clear();
	}
}
