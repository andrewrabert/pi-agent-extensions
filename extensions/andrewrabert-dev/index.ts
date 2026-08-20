import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const agentsPath = fileURLToPath(new URL("./agents", import.meta.url));
const registration = { path: agentsPath };

export default function (pi: ExtensionAPI) {
	const registerAgents = () => pi.events.emit("subagent:register-agent-path", registration);

	// Package order makes this available before session_start (including --agent).
	registerAgents();
	// Also supports loading this extension before the subagent extension.
	pi.on("session_start", registerAgents);
}
