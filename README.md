# @latere-ai/luxsdk

[![test](https://github.com/latere-ai/lux-typescript-sdk/actions/workflows/test.yml/badge.svg)](https://github.com/latere-ai/lux-typescript-sdk/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@latere-ai/luxsdk)](https://www.npmjs.com/package/@latere-ai/luxsdk)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

The TypeScript client for [Latere Lux](https://lux.latere.ai)'s
native dialect: one typed request/response/stream shape for every
model Lux routes. Zero runtime dependencies. Needs only `fetch` and
`ReadableStream` (Node ≥ 18, Bun, Deno, browsers).

## Install

```
npm install @latere-ai/luxsdk
```

```ts
import { LuxClient, userText } from "@latere-ai/luxsdk";

const c = new LuxClient("https://lux.latere.ai", { apiKey: process.env.LUX_API_KEY! });

const res = await c.generate({
  model: "claude-sonnet-5",
  max_tokens: 256,
  messages: [userText("Hello")],
});
console.log(res.blocks[0]?.text, res.usage);
```

Running that needs a reachable gateway and a credential it accepts. The
snippet reads `LUX_API_KEY` from the environment; without one the call
fails at the gateway with a `LuxError` rather than proceeding
unauthenticated.

### Configure from the environment

Both connection values fall back to `LUX_BASE_URL` and `LUX_API_KEY`
when omitted, so a configured process can construct with no arguments:

```sh
eval "$(latere lux env --compat lux)"   # exports both, using your login
```

```ts
const c = new LuxClient();
```

Explicit arguments always win: the environment only fills what you left
unset, so exporting `LUX_BASE_URL` can never redirect a client that
passed its own. With neither an argument nor `LUX_BASE_URL`, the base
falls back to `DEFAULT_BASE_URL` (`https://lux.latere.ai`). A credential
has no such default: an unset `LUX_API_KEY` stays empty, so a misspelled
variable fails at the gateway instead of becoming an anonymous call.

## Streaming

```ts
const st = await c.stream({ model: "claude-sonnet-5", messages: [userText("Hi")] });
for await (const ev of st) {
  if (ev.type === "text_delta") process.stdout.write(ev.delta ?? "");
}
```

The stream grammar is the gateway IR's, verbatim:

```
message_start (block_start (text_delta|args_delta|thinking_delta|signature_delta)* block_stop)* message_delta message_stop
```

Assemble a streamed tool call from `block_start` (id, name) plus
`args_delta` fragments, closed by that index's `block_stop`. `usage`
appears on `message_start` (input side) and `message_delta` (output
side); accumulate both. Iteration ends after `message_stop`; a
mid-stream gateway failure throws `LuxStreamError`. `st.close()`
releases the connection early, without draining the rest of the
events.

## Token counting

```ts
const tc = await c.countTokens({ model: "claude-sonnet-5", messages: [userText("Hi")] });
// tc.input_tokens; tc.estimated is true when the target has no native tokenizer
```

## Auth

`apiKey` is a static bearer (a Lux virtual key). `tokenSource` supplies
a per-call bearer (e.g. a rotating JWT) and wins over `apiKey`.

## Cost attribution

`costTags` attributes a call's cost to named dimensions within your own
spend, sent as the `Lux-Cost-Tag` header. It never changes who is billed
or what the key can reach. Pass a `Record<string, string>`, serialized to
sorted `key=value` pairs:

```ts
const c = new LuxClient("https://lux.latere.ai", {
  apiKey: process.env.LUX_API_KEY!,
  costTags: { tenant: "acme" }, // client-wide default
});

// Per call; replaces the client default.
const res = await c.generate({
  model: "claude-sonnet-5",
  messages: [userText("Hi")],
  costTags: { tenant: "acme", project: "web" }, // sent as project=web,tenant=acme
});
```

A per-call `costTags` replaces the client default only when it holds at
least one pair. An empty map (`{}`) counts as no per-call tags, so the
client default applies, the same as if you omit the field. This keeps
code that builds tags dynamically from losing cost attribution silently.
While a client default is set, you cannot send a call with no tags.

Tags come from a restricted charset, because the header format has no
escaping: keys match `[A-Za-z0-9._-]+`, values additionally allow `:` and
`/`. A key is at most 64 bytes, a value 128, and one call carries at most
8 pairs.

Anything outside that throws `LuxError` before the request is sent, so a
value like `"b,c=d"` never reaches the gateway as two tags the caller did
not write. The gateway applies the same rules and answers a `400` for a
header assembled elsewhere.

## Errors and loss

Non-2xx responses throw `LuxError { status, code, message, requestId }`
with the retryable type vocabulary (`rate_limit_error`,
`overloaded_error`, ...). Request fields the target dialect cannot
represent are never silently dropped: they arrive as `result.loss` /
`stream.loss` from the `X-Lux-Compat-Loss` header.

## API surface

| Export | Kind | What it is |
|---|---|---|
| `LuxClient` | class | The client. `generate`, `stream`, `countTokens`. |
| `LuxClientOptions` | interface | `apiKey`, `tokenSource`, `costTags`, `fetch`. |
| `LuxRequest` | interface | One request: `model`, `messages`, `system`, `tools`, `tool_choice`, `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `reasoning`, `schema`, `user_id`, `costTags`. |
| `LuxResult` | interface | `generate`'s return: a `LuxResponse` plus `loss`. |
| `LuxResponse`, `Usage` | interface | `id`, `model`, `blocks`, `stop_reason`, `stop_sequence`, `usage`. |
| `LuxStream`, `LuxEvent` | interface | The async-iterable stream and its event frames. |
| `TokenCount` | interface | `countTokens`'s return: `input_tokens`, `estimated`. |
| `Message`, `Block`, `Image`, `Tool`, `ToolUse`, `ToolResult`, `ToolChoice`, `Reasoning`, `ResponseSchema` | interface | Wire shapes, snake_case verbatim. |
| `Role`, `BlockType`, `ToolChoiceMode`, `Effort`, `StopReason`, `EventType` | type | Wire enums, open where the wire is open. |
| `userText`, `assistantText` | function | One-block turn of the given role. |
| `LuxError`, `LuxStreamError` | class | Request-level and mid-stream failures. |
| `ENV_BASE_URL`, `ENV_API_KEY`, `DEFAULT_BASE_URL` | const | `"LUX_BASE_URL"`, `"LUX_API_KEY"`, `"https://lux.latere.ai"`. |

`fetch` in `LuxClientOptions` replaces the global implementation, which
is how the tests drive the client and how you would route calls through
a custom agent or proxy.

## Testing

```sh
bun install
bun test --coverage
bunx tsc --noEmit
```

The suite runs against an in-process HTTP server, so it needs no live
gateway, no credential and no network. Nothing is skipped for missing
setup: the count `bun test` prints is the whole suite.

## Versioning

Pre-1.0. The wire shapes track the gateway's native dialect and are
stable in practice; the TypeScript surface may still change in a minor
version. Releases are tagged `vX.Y.Z` and published to npm from that
tag.

## License

Apache-2.0. See [LICENSE](LICENSE).
