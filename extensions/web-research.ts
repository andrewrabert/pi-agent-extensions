import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const USER_AGENT = "pi-web-research/1.0 (+https://pi.dev)";
const MAX_DOWNLOAD_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 20_000;

function decodeEntities(text: string): string {
	const named: Record<string, string> = {
		amp: "&",
		apos: "'",
		gt: ">",
		lt: "<",
		nbsp: " ",
		quot: '"',
	};
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
		const hex = entity[1]?.toLowerCase() === "x";
		const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
		return Number.isFinite(value) ? String.fromCodePoint(value) : match;
	});
}

function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
			.replace(/<(br|hr)\b[^>]*>/gi, "\n")
			.replace(/<\/(p|div|article|section|main|header|footer|nav|aside|li|h[1-6]|tr)>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/\r/g, "")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function isPrivateAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const [a, b] = address.split(".").map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			a >= 224
		);
	}

	const normalized = address.toLowerCase().split("%")[0];
	if (normalized === "::" || normalized === "::1") return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	if (/^fe[89ab]/.test(normalized)) return true;
	if (normalized.startsWith("ff")) return true;
	if (normalized.startsWith("::ffff:")) {
		const mapped = normalized.slice("::ffff:".length);
		return isIP(mapped) === 4 ? isPrivateAddress(mapped) : true;
	}
	return false;
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only http:// and https:// URLs are allowed");
	}
	if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
	const rawHostname = url.hostname.toLowerCase();
	const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
		? rawHostname.slice(1, -1)
		: rawHostname;
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error("Local URLs are not allowed");
	}

	const literalFamily = isIP(hostname);
	if (literalFamily) {
		if (isPrivateAddress(hostname)) throw new Error("Private or local network URLs are not allowed");
	} else {
		const addresses = await lookup(hostname, { all: true, verbatim: true });
		if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
			throw new Error("Host resolves to a private or local network address");
		}
	}
	return url;
}

async function fetchPublic(rawUrl: string, signal?: AbortSignal): Promise<Response> {
	let current = rawUrl;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		const url = await assertPublicUrl(current);
		const requestSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
			: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const response = await fetch(url, {
			redirect: "manual",
			signal: requestSignal,
			headers: {
				Accept: "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1",
				"User-Agent": USER_AGENT,
			},
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) throw new Error(`Redirect response ${response.status} had no Location header`);
		current = new URL(location, url).href;
	}
	throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
}

async function readLimited(response: Response): Promise<{ text: string; truncated: boolean }> {
	if (!response.body) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		const remaining = MAX_DOWNLOAD_BYTES - total;
		if (value.byteLength > remaining) {
			if (remaining > 0) chunks.push(value.slice(0, remaining));
			truncated = true;
			await reader.cancel();
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

function truncateForTool(text: string): string {
	const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!result.truncated) return result.content;
	return `${result.content}\n\n[Output truncated: showing ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}).]`;
}

function unwrapDuckDuckGoUrl(href: string): string {
	const absolute = href.startsWith("//") ? `https:${href}` : href;
	try {
		const url = new URL(absolute, "https://html.duckduckgo.com/");
		return url.searchParams.get("uddg") ?? url.href;
	} catch {
		return absolute;
	}
}

function parseSearchResults(html: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
	const results: Array<{ title: string; url: string; snippet: string }> = [];
	const blocks = html.split(/class=["']result results_links[^"']*["']/i).slice(1);
	for (const block of blocks) {
		const link = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
			?? block.match(/<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
		if (!link) continue;
		const snippetMatch = block.match(/<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
		results.push({
			title: htmlToText(link[2]),
			url: unwrapDuckDuckGoUrl(decodeEntities(link[1])),
			snippet: snippetMatch ? htmlToText(snippetMatch[1]) : "",
		});
		if (results.length >= limit) break;
	}
	return results;
}

export default function webResearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the public web. Returns result titles, URLs, and snippets; fetch cited pages with web_fetch.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Integer({ description: "Maximum results (default 8, maximum 20)", minimum: 1, maximum: 20 })),
		}),
		async execute(_toolCallId, params, signal) {
			const limit = params.limit ?? 8;
			const response = await fetchPublic(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`, signal);
			if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`);
			const downloaded = await readLimited(response);
			const results = parseSearchResults(downloaded.text, limit);
			if (results.length === 0) throw new Error("Search returned no parseable results");
			const text = results
				.map((result, index) => `${index + 1}. ${result.title}\n${result.url}${result.snippet ? `\n${result.snippet}` : ""}`)
				.join("\n\n");
			return { content: [{ type: "text" as const, text: truncateForTool(text) }], details: { query: params.query, results } };
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "Fetch a public HTTP(S) page read-only and return readable text. Local and private-network URLs are blocked.",
		parameters: Type.Object({ url: Type.String({ description: "Public http:// or https:// URL" }) }),
		async execute(_toolCallId, params, signal) {
			const response = await fetchPublic(params.url, signal);
			if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status} ${response.statusText}`);
			const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
			if (contentType && !/^(text\/|application\/(json|xml|xhtml\+xml))/.test(contentType)) {
				throw new Error(`Unsupported content type: ${contentType}`);
			}
			const downloaded = await readLimited(response);
			const body = contentType.includes("html") ? htmlToText(downloaded.text) : downloaded.text.trim();
			const header = `URL: ${response.url}\nStatus: ${response.status}\nContent-Type: ${contentType || "unknown"}`;
			const downloadNotice = downloaded.truncated ? `\n[Download truncated at ${formatSize(MAX_DOWNLOAD_BYTES)}.]` : "";
			return {
				content: [{ type: "text" as const, text: truncateForTool(`${header}${downloadNotice}\n\n${body}`) }],
				details: { url: response.url, status: response.status, contentType, downloadTruncated: downloaded.truncated },
			};
		},
	});
}
