export interface ToolPatternResolution {
	tools: string[];
	unmatched: string[];
}

const TOOL_GRANTS: Record<string, string[]> = {
	agent: ["subagent", "subagent_send", "subagent_stop"],
};

function asteriskPattern(pattern: string): RegExp {
	const escaped = pattern.replace(/[\\^$+?.()|[\]{}]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/** Expand asterisk patterns against the registered tool names. */
export function resolveToolPatterns(patterns: string[], availableTools: string[]): ToolPatternResolution {
	const tools: string[] = [];
	const unmatched: string[] = [];
	const seen = new Set<string>();

	for (const pattern of patterns) {
		const grant = TOOL_GRANTS[pattern];
		const matches = grant
			? grant.filter((tool) => availableTools.includes(tool))
			: pattern.includes("*")
				? availableTools.filter((tool) => asteriskPattern(pattern).test(tool))
				: availableTools.includes(pattern)
					? [pattern]
					: [];

		if (matches.length === 0) {
			unmatched.push(pattern);
			continue;
		}

		for (const tool of matches) {
			if (!seen.has(tool)) {
				seen.add(tool);
				tools.push(tool);
			}
		}
	}

	return { tools, unmatched };
}
