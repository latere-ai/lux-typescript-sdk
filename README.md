# @latere-ai/luxsdk

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
passed its own.

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
mid-stream gateway failure throws `LuxStreamError`.

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

// Per call; overrides the client default.
const res = await c.generate({
  model: "claude-sonnet-5",
  messages: [userText("Hi")],
  costTags: { tenant: "acme", project: "web" }, // sent as project=web,tenant=acme
});
```

The gateway validates the value and rejects a malformed one with a
`400`; the SDK passes it through untouched.

## Errors and loss

Non-2xx responses throw `LuxError { status, code, message, requestId }`
with the retryable type vocabulary (`rate_limit_error`,
`overloaded_error`, ...). Request fields the target dialect cannot
represent are never silently dropped: they arrive as `result.loss` /
`stream.loss` from the `X-Lux-Compat-Loss` header.
