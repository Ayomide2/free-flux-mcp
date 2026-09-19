# AI Agent Visibility

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/agent-visibility-template)

<!-- dash-content-start -->

Search is shifting from links to answers. To show up in those answers, your content has to be readable by AI agents and crawlers — in whatever convention each one looks for. This template makes your site visible across **every** agent-discovery surface from a single content store, powered by [Workers AI](https://developers.cloudflare.com/workers-ai/).

**How it works:** the Worker enriches your content once with Workers AI — deriving a clean title, an agent-friendly summary, key points, and topic tags — caches it in [KV](https://developers.cloudflare.com/kv/), then projects that one store onto every surface an agent might request:

- **`/llms.txt`** and **`/llms-full.txt`** — the [llms.txt](https://llmstxt.org) index conventions
- **`/index.json`** — a typed JSON index for structured agents
- **`/<slug>.md`** — clean per-page Markdown, ideal for grounding and citation
- **`/robots.txt`** — explicit directives that welcome named AI crawlers
- **`Content-Signal` headers** — declare how agents may use your content
- **JSON-LD** (`/jsonld`, `/<slug>.jsonld`) — schema.org structured data for classic and AI crawlers
- **Web Bot Auth** _(optional)_ — verify the identity of signed agents (RFC 9421, Ed25519)

The same data, in whichever shape an agent prefers. A bundled UI lets you preview and copy each surface live.

This template ships with sample content so it works the moment you deploy it. Point it at your own pages by editing `src/lib/content.ts`, or POST content to `/api/resources` to enrich it on the fly.

<!-- dash-content-end -->

## Who is this for

- **Anyone who wants to show up in AI answers.** If readers increasingly ask ChatGPT, Claude, or Perplexity instead of clicking a search result, this gives those agents a clean, structured copy of your content to cite.
- **Developers exploring AEO (Answer Engine Optimization).** A working reference for the emerging set of agent-discovery conventions, all in one Worker.
- **Teams who keep getting agent 4xxs.** If bot analytics show AI agents hitting paths they can't read, this is the fix: serve them content they can.

> Looking for a commerce-specific version? See the [`commerce-llms-txt-template`](../commerce-llms-txt-template) for a product-catalog–focused `/llms.txt`. This template is the general, multi-surface counterpart.

## Getting Started

Outside of this repo, you can start a new project with this template using [C3](https://developers.cloudflare.com/learning-paths/workers/get-started/first-worker/) (the `create-cloudflare` CLI):

```bash
npm create cloudflare@latest -- --template=cloudflare/templates/agent-visibility-template
```

A live preview is generated for every pull request via the Deploy to Cloudflare button above.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a KV namespace and add its ID to `wrangler.jsonc` (replace the example namespace ID):

   ```bash
   npx wrangler kv namespace create VISIBILITY_CACHE
   ```

3. Set your site identity in `wrangler.jsonc` under `vars` (`SITE_NAME`, `SITE_DESCRIPTION`).

4. (Optional) To use the runtime write API, set an admin secret — the
   `POST` routes are disabled until you do:

   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```

5. Run locally:

   ```bash
   npm run dev
   ```

6. Deploy:

   ```bash
   npm run deploy
   ```

## After it deploys

The Worker is live immediately with the bundled sample content — no data source
required. Visit the root URL for the surface explorer UI, then check the live
agent surfaces:

- `https://<your-worker>/llms.txt` and `/llms-full.txt`
- `https://<your-worker>/index.json`
- `https://<your-worker>/getting-started.md` (any sample slug)
- `https://<your-worker>/robots.txt`

The first request to a surface enriches the content with Workers AI and caches
it; subsequent requests are served from KV. Replace the sample content (see
[Adding your own content](#adding-your-own-content)) to make it yours.

## Configuration

All configuration lives in `wrangler.jsonc` under `vars`:

| Variable               | Description                                                   | Default                                    |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `SITE_NAME`            | Your site's name, shown across every surface                  | `Acme Docs`                                |
| `SITE_DESCRIPTION`     | One-line description for agents                               | _(sample)_                                 |
| `AI_MODEL`             | Workers AI model used for enrichment                          | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `ENRICHMENT_CACHE_TTL` | Seconds to cache enriched records in KV                       | `3600`                                     |
| `CONTENT_SIGNAL`       | Content-Signal policy (emitted in robots.txt and as a header) | `ai-input=yes, search=yes, ai-train=no`    |
| `ENABLE_WEB_BOT_AUTH`  | Expose the optional agent-identity surface                    | `false`                                    |

Secrets (set with `npx wrangler secret put <NAME>`, never committed):

| Secret        | Description                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_TOKEN` | Bearer token required by the mutating API routes (`POST /api/resources`, `POST /api/refresh`). While unset, those routes return `401`. |

## Adding your own content

**Option A — edit the source:** replace the entries in `src/lib/content.ts` with your own pages (`slug`, `url`, optional `title`, and `body` as HTML or Markdown), then redeploy.

**Option B — POST at runtime:** with `ADMIN_TOKEN` set, send content to the API and it's enriched and added immediately:

```bash
curl -X POST https://your-worker.workers.dev/api/resources \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"slug":"about","url":"https://example.com/about","title":"About","body":"<h1>About us</h1>..."}'
```

Slugs must match `^[a-z0-9-]{1,63}$`, `url` must be `http(s)`, bodies are capped
at 100 KB, and the store holds up to 100 resources. Call `POST /api/refresh`
(also authenticated) to clear the cache and re-enrich from source.

## Endpoints

| Method | Path                                  | Description                                                  |
| ------ | ------------------------------------- | ------------------------------------------------------------ |
| GET    | `/llms.txt`                           | llms.txt index (Markdown)                                    |
| GET    | `/llms-full.txt`                      | Full content inlined (Markdown)                              |
| GET    | `/index.json`                         | Typed JSON index                                             |
| GET    | `/:slug.md`                           | Per-page Markdown                                            |
| GET    | `/:slug.jsonld`                       | Per-page schema.org JSON-LD                                  |
| GET    | `/jsonld`                             | Site-level schema.org JSON-LD                                |
| GET    | `/robots.txt`                         | AI-bot directives                                            |
| GET    | `/api/site`                           | Site config + surface list (used by the UI)                  |
| GET    | `/api/resources`                      | Enriched resources as JSON                                   |
| GET    | `/api/resources/:slug`                | A single enriched resource                                   |
| POST   | `/api/resources`                      | Enrich and add/replace a resource _(requires `ADMIN_TOKEN`)_ |
| POST   | `/api/refresh`                        | Clear the enrichment cache _(requires `ADMIN_TOKEN`)_        |
| GET    | `/.well-known/web-bot-auth/directory` | Trusted agent keys _(if enabled)_                            |
| POST   | `/api/identity`                       | Verify a signed agent request _(if enabled)_                 |
| POST   | `/mcp`                                | MCP server (Streamable HTTP, JSON-RPC) — image + audio generation |

## MCP endpoint (image + audio generation)

`POST /mcp` is a separate, self-contained MCP server bolted onto this Worker.
It exposes two independent tools that share nothing but the endpoint — no
KV, no enrichment, and a failure or slowdown in one never affects the other:

- **`generate_widescreen_drawing`** — renders a 16:9 illustration with
  Workers AI's `@cf/blackforestlabs/flux-1-schnell` model and returns it as a
  base64 PNG.
- **`generate_narration`** — converts a text script into spoken narration
  with Workers AI's `minimax/speech-2.8-turbo` model (a third-party,
  zero-data-retention partner model — note the bare `minimax/...` id, no
  `@cf/` prefix), returning a base64 MP3. Defaults to this project's cloned
  "Jen" voice (`voice_id`), overridable per call. MiniMax caps input at
  10,000 characters per request; longer scripts are automatically split on
  whitespace boundaries into multiple calls and the resulting MP3 byte
  streams are concatenated before being returned.

### How a client makes a request

The endpoint speaks the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http):
every call is a single `POST /mcp` with a JSON-RPC 2.0 body, and the Worker
answers with a single JSON-RPC response (no SSE stream). A session always
follows the same three steps:

1. **`initialize`** — handshake, returns server info and capabilities.
2. **`notifications/initialized`** — a notification (no `id`, no response
   body expected) telling the server the client is ready. The Worker replies
   `202 Accepted` with an empty body.
3. **`tools/list`** and **`tools/call`** — discover and invoke the tool.

```bash
# 1. Initialize
curl -s https://<your-worker>.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

# 2. Tell the server you're ready (fire-and-forget notification)
curl -s https://<your-worker>.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. Discover the tools
curl -s https://<your-worker>.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 4a. Call the image tool
curl -s https://<your-worker>.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{
        "jsonrpc":"2.0",
        "id":3,
        "method":"tools/call",
        "params":{
          "name":"generate_widescreen_drawing",
          "arguments":{"prompt":"a lighthouse at sunset"}
        }
      }'

# 4b. Call the narration tool (independently — same endpoint, different tool name)
curl -s https://<your-worker>.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{
        "jsonrpc":"2.0",
        "id":4,
        "method":"tools/call",
        "params":{
          "name":"generate_narration",
          "arguments":{"text":"Welcome to the show."}
        }
      }'
```

A successful `tools/call` response looks like:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "image", "data": "<base64 PNG>", "mimeType": "image/png" }]
  }
}
```

(`generate_narration` returns the same shape with `"type": "audio"`,
`"mimeType": "audio/mpeg"`, and base64 MP3 bytes in `data`.)

If generation itself fails (e.g. the model errors), the response is still
`200 OK`, but `result.isError` is `true` and `result.content` carries a text
explanation instead of media — that's the MCP convention for a tool that
ran but failed, as opposed to a broken request. A malformed request (unknown
method, unknown tool name, missing `prompt`/`text`) comes back as a JSON-RPC
`error` object, also on `200 OK`; only a request whose body isn't valid JSON
at all gets a non-2xx (`400`) HTTP status. Client SDKs generally treat any
non-2xx as a hard transport failure and never inspect the JSON-RPC body, so
this distinction is what keeps ordinary tool errors visible to the caller
instead of surfacing as an opaque connection failure.

### Configuring an MCP client/session

Most MCP hosts (Claude Desktop, Claude Code, other Streamable-HTTP-capable
clients) just need the URL — they run the `initialize` → `tools/list` →
`tools/call` sequence above automatically once connected. For example, in
Claude Code:

```bash
claude mcp add --transport http free-flux-mcp https://<your-worker>.workers.dev/mcp
```

or in a client that takes a JSON config (e.g. `claude_desktop_config.json` /
`.mcp.json`):

```json
{
  "mcpServers": {
    "free-flux-mcp": {
      "type": "http",
      "url": "https://<your-worker>.workers.dev/mcp"
    }
  }
}
```

Once connected, ask the client to draw something, or to narrate a script —
it picks the tool that matches the request (`generate_widescreen_drawing` or
`generate_narration`) and gets the result back over the same `/mcp`
endpoint.

### Routing image vs. audio requests from your own project

If you're driving this from your own code instead of an MCP-native client —
for example a project running on an EC2 instance under Claude Code — there
is no separate routing layer to build. Both tools live on the one `/mcp`
JSON-RPC endpoint; "routing" is just picking `params.name` per request:

- Image request → `tools/call` with `name: "generate_widescreen_drawing"`.
- Audio/script request → `tools/call` with `name: "generate_narration"`.

They're independent calls against the same URL: a narration request never
touches the image code path and vice versa, so a problem in one tool (a bad
prompt, a MiniMax error) can't take down the other. To run this yourself:

```bash
git clone https://github.com/<you>/free-flux-mcp.git
cd free-flux-mcp
npm install
npm run deploy   # or `npm run dev` to test locally first
```

Then point your EC2-hosted project at `https://<your-worker>.workers.dev/mcp`
and dispatch on request type as above — no polling, no queue, just one
`POST` per request.

## Caching

Enrichment is the expensive step (one Workers AI call per page), so results are
cached in KV under a single key and reused until `ENRICHMENT_CACHE_TTL` expires
(default 1 hour). A `POST /api/resources` enriches only the new/changed page and
updates the cache in place; `POST /api/refresh` clears the cache so the next
read re-enriches from source. If Workers AI is briefly unavailable, the Worker
falls back to deterministic enrichment and caches that degraded result for only
60 seconds so a transient outage can't poison your surfaces for the full TTL.

## Known limitations

- **Enrichment runs on the request path.** The first request after a cold cache
  enriches all pages inline, so it's slower than cached reads. For large sites,
  move enrichment to a [Queue](https://developers.cloudflare.com/queues/) or a
  scheduled [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
- **The store lives in two KV keys** and is capped at 100 resources / 100 KB per
  body to stay well within KV limits. For larger catalogs, switch to one KV key
  per resource (or D1) and add pagination.
- **KV is eventually consistent.** After a `POST`, a surface read in another
  region may briefly serve the previous version.
- **Runtime writes use KV read-modify-write.** The mutating API is intended for
  lightweight admin updates. Avoid concurrent writes; for high-volume or
  multi-writer workflows, serialize writes through a Durable Object or move the
  store to D1.
- **Web Bot Auth is a minimal reference** (see below), not a hardened
  implementation — review the current drafts before relying on it.

## Optional: Web Bot Auth (agent identity)

Everything above is about making content **readable**. Web Bot Auth is a
different axis — letting a well-behaved agent prove **who it is** with signed
requests ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421), Ed25519). It's
off by default. Set `ENABLE_WEB_BOT_AUTH=true` to expose a key directory at
`/.well-known/web-bot-auth/directory` and a verification endpoint at
`/api/identity`. Replace the sample keys in `src/lib/web-bot-auth.ts` with the
keys of agents you actually trust, and review the latest Web Bot Auth drafts
before relying on it in production.

## Testing

```bash
npm test
```

The test suite seeds the KV cache before hitting the public surfaces, so it can
run locally without making Workers AI requests.

## License

See the repository [LICENSE](../LICENSE).
