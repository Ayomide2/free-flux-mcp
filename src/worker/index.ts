/**
 * Agent Visibility Worker
 *
 * Serves one enriched content store through every agent-discovery surface:
 *
 *   GET /llms.txt                          — llms.txt index (Markdown)
 *   GET /llms-full.txt                     — full content inlined (Markdown)
 *   GET /index.json                        — typed JSON index
 *   GET /:slug.md                          — per-page Markdown (groundable)
 *   GET /:slug.jsonld                      — per-page schema.org JSON-LD
 *   GET /jsonld                            — site-level schema.org JSON-LD
 *   GET /robots.txt                        — explicit AI-bot directives
 *
 * Plus a small JSON API the bundled UI uses, and an OPTIONAL Web Bot Auth
 * identity surface (disabled unless ENABLE_WEB_BOT_AUTH=true).
 *
 * Every text surface sends a `Content-Signal` header declaring how agents may
 * use the content (see https://contentsignals.org / the Content-Signals
 * proposal). The React SPA at `/` is served from static assets.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	renderIndexJson,
	renderLlmsFullTxt,
	renderLlmsTxt,
	renderResourceJsonLd,
	renderResourceMd,
	renderRobotsTxt,
	renderWebsiteJsonLd,
} from "../enrichment/surfaces";
import {
	clearCache,
	getResources,
	siteConfig,
	upsertResource,
} from "../lib/store";
import type { Env, RawResource } from "../lib/types";
import {
	directoryDocument,
	SAMPLE_AGENT_KEYS,
	verifyAgentIdentity,
} from "../lib/web-bot-auth";

const app = new Hono<{ Bindings: Env }>();

// "Jen" — a voice clone created on Ayo's own MiniMax account (consent
// confirmed for this project's use). Used as the default voice for
// generate_narration; callers may override it with their own voice_id.
const DEFAULT_NARRATION_VOICE_ID = "moss_audio_32186ec7-b449-11f1-80cc-aac30e71d302";

// minimax/speech-2.8-turbo caps input at 10,000 characters per request.
// Longer scripts are split on whitespace boundaries and synthesized as
// separate chunks, then the resulting MP3 byte streams are concatenated.
const MINIMAX_TEXT_LIMIT = 10_000;

function chunkNarrationText(text: string, maxLen = MINIMAX_TEXT_LIMIT): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > maxLen) {
		let cut = rest.lastIndexOf(" ", maxLen);
		if (cut <= 0) cut = maxLen;
		chunks.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

// No Buffer/Node APIs on the default Workers runtime — build the base64
// string manually, in chunks small enough to avoid blowing the call stack
// on String.fromCharCode(...bytes) for a multi-megabyte audio file.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

app.onError((err, c) => {
	console.error(`[Error] ${c.req.method} ${c.req.path}: ${err.message}`);
	// Match the response type to the surface: text surfaces shouldn't get a
	// JSON error body.
	if (/\.(md|txt)$/.test(c.req.path)) {
		return c.text("Internal server error", 500);
	}
	return c.json({ error: "Internal server error" }, 500);
});

// --- MCP endpoint (Streamable HTTP, single POST endpoint) ------------------
//
// Per the MCP Streamable HTTP transport, a syntactically valid JSON-RPC
// request that the server understood always gets HTTP 200 — even when the
// *result* is a JSON-RPC-level error (unknown method, unknown tool). A
// non-2xx HTTP status is reserved for transport-level failures (the body
// wasn't valid JSON at all). Most client SDKs treat any non-2xx response as
// a hard transport failure and never look at the JSON-RPC body, so returning
// 404/500 here — as earlier versions of this handler did — made every
// unknown-method or failed-tool-call response invisible to the client.
app.use("/mcp", cors());
app.post("/mcp", async (c) => {
	let body: any;
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
			400,
		);
	}

	if (body.method === "initialize") {
		return c.json({
			jsonrpc: "2.0",
			id: body.id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "flux-generator", version: "1.0.0" },
			},
		});
	}

	if (body.method === "notifications/initialized") {
		return c.body(null, 202);
	}

	if (body.method === "tools/list") {
		return c.json({
			jsonrpc: "2.0",
			id: body.id,
			result: {
				tools: [
					{
						name: "generate_widescreen_drawing",
						description:
							"Generates a simple 16:9 2D drawing illustration with a background using free credits.",
						inputSchema: {
							type: "object",
							properties: {
								prompt: { type: "string", description: "The core subject matter of the drawing." },
							},
							required: ["prompt"],
						},
					},
					{
						name: "generate_narration",
						description:
							"Generates spoken narration audio (MP3) from a text script using the project's cloned voice. Scripts over 10,000 characters are automatically split into chunks and concatenated.",
						inputSchema: {
							type: "object",
							properties: {
								text: { type: "string", description: "The narration script to convert to speech." },
								voice_id: {
									type: "string",
									description: "MiniMax voice ID to narrate with. Defaults to the project's 'Jen' voice clone.",
								},
								speed: { type: "number", description: "Speech speed, 0.5-2. Defaults to 1." },
								emotion: {
									type: "string",
									enum: ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent"],
									description: "Optional emotional tone for the narration.",
								},
							},
							required: ["text"],
						},
					},
				],
			},
		});
	}

	if (body.method === "tools/call") {
		const toolName = body.params?.name;

		if (toolName !== "generate_widescreen_drawing" && toolName !== "generate_narration") {
			return c.json({
				jsonrpc: "2.0",
				id: body.id,
				error: { code: -32602, message: `Unknown tool: ${toolName}` },
			});
		}

		if (toolName === "generate_narration") {
			const script = body.params?.arguments?.text;
			if (typeof script !== "string" || script.trim().length === 0) {
				return c.json({
					jsonrpc: "2.0",
					id: body.id,
					error: { code: -32602, message: "Missing required argument: text" },
				});
			}

			const voiceId =
				typeof body.params?.arguments?.voice_id === "string"
					? body.params.arguments.voice_id
					: DEFAULT_NARRATION_VOICE_ID;
			const speed = typeof body.params?.arguments?.speed === "number" ? body.params.arguments.speed : 1;
			const emotion =
				typeof body.params?.arguments?.emotion === "string" ? body.params.arguments.emotion : undefined;

			try {
				const chunks = chunkNarrationText(script);
				const audioBuffers: ArrayBuffer[] = [];

				for (const chunk of chunks) {
					const aiResponse = await c.env.AI.run("minimax/speech-2.8-turbo", {
						text: chunk,
						voice_id: voiceId,
						speed,
						volume: 1,
						pitch: 0,
						format: "mp3",
						...(emotion ? { emotion } : {}),
					} as Parameters<Ai["run"]>[1]);

					const audioUrl = (aiResponse as { audio: string }).audio;
					const audioRes = await fetch(audioUrl);
					if (!audioRes.ok) {
						throw new Error(`Failed to fetch generated audio chunk (HTTP ${audioRes.status})`);
					}
					audioBuffers.push(await audioRes.arrayBuffer());
				}

				const totalLength = audioBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
				const combined = new Uint8Array(totalLength);
				let offset = 0;
				for (const buf of audioBuffers) {
					combined.set(new Uint8Array(buf), offset);
					offset += buf.byteLength;
				}

				return c.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						content: [{ type: "audio", data: arrayBufferToBase64(combined.buffer), mimeType: "audio/mpeg" }],
					},
				});
			} catch (err) {
				console.error(`[MCP] generate_narration failed: ${(err as Error).message}`);
				return c.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						isError: true,
						content: [{ type: "text", text: `Narration generation failed: ${(err as Error).message}` }],
					},
				});
			}
		}

		const userPrompt = body.params?.arguments?.prompt;
		if (typeof userPrompt !== "string" || userPrompt.trim().length === 0) {
			return c.json({
				jsonrpc: "2.0",
				id: body.id,
				error: { code: -32602, message: "Missing required argument: prompt" },
			});
		}

		try {
			const stylizedPrompt = `${userPrompt}, simple clean drawing style, 2D vector graphic illustration, clean solid background, non-photorealistic art`;

			const aiResponse = await c.env.AI.run("@cf/blackforestlabs/flux-1-schnell", {
				prompt: stylizedPrompt,
				width: 1024,
				height: 576,
				num_inference_steps: 4,
			});

			const base64Image = (aiResponse as { image: string }).image;

			return c.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					content: [{ type: "image", data: base64Image, mimeType: "image/png" }],
				},
			});
		} catch (err) {
			// A failed tool execution is reported *inside* the result (isError),
			// not as a JSON-RPC error — this is a normal outcome the calling
			// model should see and can react to, not a protocol failure.
			console.error(`[MCP] generate_widescreen_drawing failed: ${(err as Error).message}`);
			return c.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					isError: true,
					content: [{ type: "text", text: `Image generation failed: ${(err as Error).message}` }],
				},
			});
		}
	}

	return c.json({
		jsonrpc: "2.0",
		id: body.id,
		error: { code: -32601, message: `Method not found: ${body.method}` },
	});
});

function originOf(url: string): string {
	return new URL(url).origin;
}

// --- Validation limits for user-supplied content ---------------------------
const MAX_BODY_BYTES = 100_000; // raw content we'll persist per resource
const MAX_RESOURCES = 100; // cap total resources to bound KV growth
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

/** Constant-time-ish bearer check for the mutating routes. */
function isAuthorized(c: {
	env: Env;
	req: { header: (k: string) => string | undefined };
}): boolean {
	const configured = c.env.ADMIN_TOKEN;
	if (!configured) return false;
	const header = c.req.header("authorization") ?? "";
	const token = header.replace(/^Bearer\s+/i, "");
	return token.length > 0 && token === configured;
}

/** Apply the Content-Signal header declaring agent usage intent. */
function contentSignal(c: { env: Env }): Record<string, string> {
	return {
		"Content-Signal":
			c.env.CONTENT_SIGNAL || "ai-input=yes, search=yes, ai-train=no",
	};
}

// CORS so agents can fetch the machine-readable surfaces from anywhere.
app.use("/llms.txt", cors());
app.use("/llms-full.txt", cors());
app.use("/index.json", cors());
app.use("/jsonld", cors());
// NB: Hono's "*" wildcard does not match a literal ".md"/".jsonld" suffix, so
// the per-page surfaces need the same regex matcher their routes use.
app.use("/:file{.+\\.md}", cors());
app.use("/:file{.+\\.jsonld}", cors());

// ---------------------------------------------------------------------------
// Machine-readable surfaces
// ---------------------------------------------------------------------------

app.get("/llms.txt", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	return c.text(renderLlmsTxt({ site, resources }), 200, {
		"Content-Type": "text/plain; charset=utf-8",
		...contentSignal(c),
	});
});

app.get("/llms-full.txt", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	return c.text(renderLlmsFullTxt({ site, resources }), 200, {
		"Content-Type": "text/plain; charset=utf-8",
		...contentSignal(c),
	});
});

app.get("/index.json", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	c.header("Content-Signal", contentSignal(c)["Content-Signal"]);
	return c.json(renderIndexJson({ site, resources }));
});

app.get("/robots.txt", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	return c.text(
		renderRobotsTxt({
			site,
			resources,
			contentSignal: contentSignal(c)["Content-Signal"],
		}),
		200,
		{
			"Content-Type": "text/plain; charset=utf-8",
			...contentSignal(c),
		},
	);
});

app.get("/jsonld", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	return c.json(renderWebsiteJsonLd({ site, resources }), 200, {
		"Content-Type": "application/ld+json; charset=utf-8",
		...contentSignal(c),
	});
});

// Per-page Markdown: /:slug.md
app.get("/:file{.+\\.md}", async (c) => {
	const slug = c.req.param("file").replace(/\.md$/, "");
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	const resource = resources.find((r) => r.slug === slug);
	if (!resource) return c.notFound();
	return c.text(renderResourceMd({ resource, site }), 200, {
		"Content-Type": "text/markdown; charset=utf-8",
		...contentSignal(c),
	});
});

// Per-page JSON-LD: /:slug.jsonld
app.get("/:file{.+\\.jsonld}", async (c) => {
	const slug = c.req.param("file").replace(/\.jsonld$/, "");
	const site = siteConfig(c.env, originOf(c.req.url));
	const resources = await getResources(c.env);
	const resource = resources.find((r) => r.slug === slug);
	if (!resource) return c.notFound();
	return c.json(renderResourceJsonLd({ resource, site }), 200, {
		"Content-Type": "application/ld+json; charset=utf-8",
		...contentSignal(c),
	});
});

// ---------------------------------------------------------------------------
// JSON API for the bundled UI
// ---------------------------------------------------------------------------

app.get("/api/site", async (c) => {
	const site = siteConfig(c.env, originOf(c.req.url));
	return c.json({
		site,
		webBotAuthEnabled: c.env.ENABLE_WEB_BOT_AUTH === "true",
		surfaces: [
			{ id: "llms-txt", label: "llms.txt", path: "/llms.txt", kind: "text" },
			{
				id: "llms-full",
				label: "llms-full.txt",
				path: "/llms-full.txt",
				kind: "text",
			},
			{
				id: "index-json",
				label: "index.json",
				path: "/index.json",
				kind: "json",
			},
			{ id: "robots", label: "robots.txt", path: "/robots.txt", kind: "text" },
			{ id: "jsonld", label: "JSON-LD", path: "/jsonld", kind: "json" },
		],
	});
});

app.get("/api/resources", async (c) => {
	const resources = await getResources(c.env);
	return c.json({ count: resources.length, resources });
});

app.get("/api/resources/:slug", async (c) => {
	const resources = await getResources(c.env);
	const resource = resources.find((r) => r.slug === c.req.param("slug"));
	if (!resource) return c.json({ error: "Not found" }, 404);
	return c.json(resource);
});

app.post("/api/resources", async (c) => {
	if (!isAuthorized(c)) {
		return c.json({ error: "Unauthorized. Set the ADMIN_TOKEN secret." }, 401);
	}
	const body = await c.req.json<Partial<RawResource>>().catch(() => null);
	if (!body?.slug || !body?.body) {
		return c.json({ error: "Missing required fields: slug, body" }, 400);
	}

	const slug = String(body.slug);
	if (!SLUG_RE.test(slug)) {
		return c.json({ error: "Invalid slug: use 1–63 chars of [a-z0-9-]." }, 400);
	}

	const rawBody = String(body.body);
	if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
		return c.json(
			{ error: `Body too large (max ${MAX_BODY_BYTES} bytes).` },
			400,
		);
	}

	let url = `${originOf(c.req.url)}/${slug}`;
	if (body.url) {
		try {
			const parsed = new URL(String(body.url));
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return c.json({ error: "url must be http(s)." }, 400);
			}
			url = parsed.toString();
		} catch {
			return c.json({ error: "url is not a valid URL." }, 400);
		}
	}

	const raw: RawResource = {
		slug,
		url,
		title: body.title ? String(body.title).slice(0, 200) : undefined,
		body: rawBody,
	};

	try {
		const enriched = await upsertResource(c.env, raw, MAX_RESOURCES);
		return c.json(enriched, 201);
	} catch (err) {
		if ((err as Error).message === "RESOURCE_LIMIT") {
			return c.json(
				{ error: `Resource limit reached (max ${MAX_RESOURCES}).` },
				409,
			);
		}
		throw err;
	}
});

app.post("/api/refresh", async (c) => {
	if (!isAuthorized(c)) {
		return c.json({ error: "Unauthorized. Set the ADMIN_TOKEN secret." }, 401);
	}
	await clearCache(c.env);
	return c.json({
		ok: true,
		message: "Cache cleared; surfaces will re-enrich.",
	});
});

// ---------------------------------------------------------------------------
// OPTIONAL — Web Bot Auth identity surface (off by default)
// ---------------------------------------------------------------------------

app.get("/.well-known/web-bot-auth/directory", (c) => {
	if (c.env.ENABLE_WEB_BOT_AUTH !== "true") return c.notFound();
	return c.json(directoryDocument(SAMPLE_AGENT_KEYS));
});

app.all("/api/identity", async (c) => {
	if (c.env.ENABLE_WEB_BOT_AUTH !== "true") {
		return c.json({ error: "Web Bot Auth is disabled" }, 404);
	}
	const result = await verifyAgentIdentity(c.req.raw, SAMPLE_AGENT_KEYS);
	return c.json(result);
});

export default app;
