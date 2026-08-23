// The TypeScript client for the Lux gateway's native dialect: one
// typed request/response/stream shape for every model Lux routes,
// POST {base}/lux/v1/generate. Zero dependencies; needs only fetch +
// ReadableStream (Node >= 18, Bun, Deno, browsers). Field names are
// the wire's snake_case, verbatim.

export type Role = "user" | "assistant";
export type BlockType =
  | "text"
  | "image"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "redacted_thinking";
export type ToolChoiceMode = "auto" | "any" | "none" | "tool";
export type Effort = "minimal" | "low" | "medium" | "high" | (string & {});
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | (string & {});
export type EventType =
  | "message_start"
  | "block_start"
  | "text_delta"
  | "args_delta"
  | "thinking_delta"
  | "signature_delta"
  | "block_stop"
  | "message_delta"
  | "message_stop";

export interface Image {
  media_type?: string;
  data?: string;
  url?: string;
}

export interface ToolUse {
  id: string;
  name: string;
  args?: unknown;
}

export interface ToolResult {
  tool_use_id: string;
  blocks?: Block[];
  is_error?: boolean;
}

export interface Block {
  type: BlockType;
  text?: string;
  image?: Image;
  tool_use?: ToolUse;
  tool_result?: ToolResult;
  signature?: string;
  redacted?: string;
  cache_hint?: boolean;
}

export interface Message {
  role: Role;
  blocks: Block[];
}

export interface Tool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface ToolChoice {
  mode: ToolChoiceMode;
  name?: string;
  disable_parallel?: boolean;
}

export interface Reasoning {
  effort?: Effort;
  budget_tokens?: number;
}

export interface ResponseSchema {
  name?: string;
  description?: string;
  schema: unknown;
  strict?: boolean;
}

export interface LuxRequest {
  model: string;
  system?: Block[];
  messages: Message[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  reasoning?: Reasoning;
  schema?: ResponseSchema;
  user_id?: string;
  /** Cost-attribution tags for this call, sent as the `Lux-Cost-Tag`
   * header (not a wire body field). Replaces the client's `costTags`
   * default when it holds at least one pair; omitted or empty (`{}`),
   * the client default applies. There is no way to send a call with no
   * tags while the client default is set.
   *
   * Keys match `[A-Za-z0-9._-]+`, values `[A-Za-z0-9._:/-]+` (keys at
   * most 64 bytes, values 128, at most 8 pairs). The wire form has no
   * escaping, so out-of-charset input throws `LuxError` locally rather
   * than being sent. */
  costTags?: Record<string, string>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_write_input_tokens?: number;
  reasoning_tokens?: number;
}

export interface LuxResponse {
  id: string;
  model: string;
  blocks: Block[];
  stop_reason: StopReason;
  stop_sequence?: string;
  usage: Usage;
}

export interface LuxEvent {
  type: EventType;
  id?: string;
  model?: string;
  index: number;
  block?: Block;
  delta?: string;
  stop_reason?: StopReason;
  stop_sequence?: string;
  usage?: Usage;
}

export interface TokenCount {
  input_tokens: number;
  /** True when the target has no native tokenizer endpoint and the
   * count is a heuristic estimate. */
  estimated: boolean;
}

/** A completed non-streaming call: the response plus the loss report
 * (request fields the backend dialect could not represent). */
export interface LuxResult extends LuxResponse {
  loss: string[];
}

/** A non-2xx gateway response, decoded from the error envelope. */
export class LuxError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  constructor(status: number, code: string, message: string, requestId = "") {
    super(code ? `lux: ${status} ${code}: ${message}` : `lux: ${status}: ${message}`);
    this.name = "LuxError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** A mid-stream `event: error` frame from the gateway. */
export class LuxStreamError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(code ? `lux: stream error (${code}): ${message}` : `lux: stream error: ${message}`);
    this.name = "LuxStreamError";
    this.code = code;
  }
}

/** One-block user turn. */
export function userText(text: string): Message {
  return { role: "user", blocks: [{ type: "text", text }] };
}

/** One-block assistant turn. */
export function assistantText(text: string): Message {
  return { role: "assistant", blocks: [{ type: "text", text }] };
}

export interface LuxClientOptions {
  /** Static bearer: a Lux virtual key (lux_...) or any accepted token. */
  apiKey?: string;
  /** Per-call bearer (e.g. a rotating JWT); wins over apiKey. */
  tokenSource?: () => Promise<string> | string;
  /** Default cost-attribution tags for every call (header
   * `Lux-Cost-Tag`); a non-empty per-request `costTags` replaces it, an
   * empty or omitted one keeps it. Keys match
   * `[A-Za-z0-9._-]+`, values `[A-Za-z0-9._:/-]+`; out-of-charset input
   * throws `LuxError` on the first call rather than being sent. */
  costTags?: Record<string, string>;
  /** Override the fetch implementation (tests, custom agents). */
  fetch?: typeof fetch;
}

/** Gateway base, e.g. `https://lux.latere.ai`. Deliberately not
 * `LUX_API_URL`: that is the `latere` CLI's own target, and one variable
 * steering both would let `eval "$(latere lux env --compat lux)"`
 * silently retarget the CLI from a subshell. */
export const ENV_BASE_URL = "LUX_BASE_URL";
/** Carries exactly what `Authorization: Bearer` carries: a `lux_*`
 * virtual key, or a Latere Auth identity/actor token. */
export const ENV_API_KEY = "LUX_API_KEY";
/** Used when neither an explicit base URL nor `LUX_BASE_URL` is set. */
export const DEFAULT_BASE_URL = "https://lux.latere.ai";

/** Read one variable from the process environment, or "" where there is
 * no such thing. The SDK is isomorphic: in a browser or a worker
 * `process` is undefined, and touching it would throw at construction
 * rather than at the call that actually needs a credential. */
function envVar(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] ?? "";
}

const GENERATE_PATH = "/lux/v1/generate";
const COUNT_TOKENS_PATH = "/lux/v1/count_tokens";
const LOSS_HEADER = "X-Lux-Compat-Loss";
const ESTIMATED_HEADER = "X-Lux-Compat-Estimated";
const COST_TAG_HEADER = "Lux-Cost-Tag";

/** Cost-tag charset and bounds, mirroring the gateway's own validator.
 * The wire form has no escaping mechanism: the gateway splits the header
 * on "," and cuts each pair on "=", so a value carrying either character
 * would silently become extra tags rather than fail. Both sides therefore
 * restrict the charset instead. */
const COST_TAG_KEY_RE = /^[A-Za-z0-9._-]+$/;
const COST_TAG_VALUE_RE = /^[A-Za-z0-9._:/-]+$/;
const MAX_COST_TAG_PAIRS = 8;
/** Byte, not UTF-16 unit: the gateway measures with Go's len(). */
const MAX_COST_TAG_KEY_BYTES = 64;
const MAX_COST_TAG_VALUE_BYTES = 128;

const utf8 = new TextEncoder();

/** Local rejection of a request the gateway would refuse, or worse, would
 * accept as something the caller did not write. `status` is 0: nothing
 * was sent. */
function costTagError(message: string): LuxError {
  return new LuxError(0, "invalid_request_error", message);
}

/** Serialize cost tags to the `Lux-Cost-Tag` wire form: sorted
 * `key=value` pairs joined by commas, no spaces. An empty/undefined
 * map yields "".
 *
 * Keys allow `A-Za-z0-9._-`, values additionally `:` and `/`; keys are at
 * most 64 bytes, values at most 128, and a map carries at most 8 pairs.
 * Anything else throws `LuxError` before the request leaves the process. */
function formatCostTags(tags?: Record<string, string>): string {
  if (!tags) {
    return "";
  }
  const keys = Object.keys(tags).sort();
  if (keys.length > MAX_COST_TAG_PAIRS) {
    throw costTagError(
      `cost tags have ${keys.length} dimensions, at most ${MAX_COST_TAG_PAIRS} are allowed`,
    );
  }
  return keys
    .map((k) => {
      const v = tags[k] ?? "";
      // Charset first: a non-ASCII key is out of charset anyway, and
      // saying so is more useful than a byte-count complaint.
      if (!COST_TAG_KEY_RE.test(k)) {
        throw costTagError(
          `cost tag key ${JSON.stringify(k)} has an invalid character; allowed: A-Za-z0-9._-`,
        );
      }
      if (!COST_TAG_VALUE_RE.test(v)) {
        throw costTagError(
          `cost tag value for ${JSON.stringify(k)} has an invalid character; allowed: A-Za-z0-9._:/-`,
        );
      }
      if (utf8.encode(k).length > MAX_COST_TAG_KEY_BYTES) {
        throw costTagError(
          `cost tag key ${JSON.stringify(k)} exceeds ${MAX_COST_TAG_KEY_BYTES} bytes`,
        );
      }
      if (utf8.encode(v).length > MAX_COST_TAG_VALUE_BYTES) {
        throw costTagError(
          `cost tag value for ${JSON.stringify(k)} exceeds ${MAX_COST_TAG_VALUE_BYTES} bytes`,
        );
      }
      return `${k}=${v}`;
    })
    .join(",");
}

/** A live event stream. Iterate with `for await`; iteration ends
 * after message_stop. `loss` lists request fields the backend dialect
 * could not represent. */
export interface LuxStream extends AsyncIterable<LuxEvent> {
  readonly loss: string[];
  /** Release the underlying connection early. */
  close(): Promise<void>;
}

export class LuxClient {
  private readonly baseURL: string;
  private readonly opts: LuxClientOptions;
  private readonly fetchFn: typeof fetch;

  /** Both connection values fall back to the environment when omitted,
   * so a process configured by `eval "$(latere lux env --compat lux)"`
   * can construct with no arguments:
   *
   * ```ts
   * const c = new LuxClient(); // LUX_BASE_URL + LUX_API_KEY
   * ```
   *
   * Explicit arguments always win: the environment fills only what the
   * caller left unset, so exporting `LUX_BASE_URL` in a shell can never
   * redirect a program that passed its own. An omitted credential stays
   * empty rather than defaulting to unauthenticated, so a misspelled
   * variable fails at the gateway instead of becoming an anonymous
   * call. */
  constructor(baseURL = "", opts: LuxClientOptions = {}) {
    const base = baseURL || envVar(ENV_BASE_URL) || DEFAULT_BASE_URL;
    this.baseURL = base.replace(/\/+$/, "");
    this.opts =
      opts.apiKey || opts.tokenSource ? opts : { ...opts, apiKey: envVar(ENV_API_KEY) };
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** Non-streaming call; the request's stream flag is overridden off. */
  async generate(req: LuxRequest): Promise<LuxResult> {
    const { costTags, ...body } = req;
    const resp = await this.post(GENERATE_PATH, { ...body, stream: false }, costTags);
    const out = (await resp.json()) as LuxResponse;
    return { ...out, loss: parseLoss(resp) };
  }

  /** Token count without spending output tokens; no spend gates run. */
  async countTokens(req: LuxRequest): Promise<TokenCount> {
    const { costTags, ...rest } = req;
    const resp = await this.post(COUNT_TOKENS_PATH, { ...rest, stream: false }, costTags);
    const body = (await resp.json()) as { input_tokens: number };
    return {
      input_tokens: body.input_tokens,
      estimated: resp.headers.get(ESTIMATED_HEADER) === "true",
    };
  }

  /** Streaming call; the request's stream flag is overridden on. */
  async stream(req: LuxRequest): Promise<LuxStream> {
    const { costTags, ...body } = req;
    const resp = await this.post(GENERATE_PATH, { ...body, stream: true }, costTags);
    const ct = resp.headers.get("Content-Type") ?? "";
    if (!ct.startsWith("text/event-stream")) {
      throw new LuxError(resp.status, "", `expected an event stream, got ${JSON.stringify(ct)}`);
    }
    if (!resp.body) {
      throw new LuxError(resp.status, "", "response has no body");
    }
    const loss = parseLoss(resp);
    const reader = resp.body.getReader();
    return {
      loss,
      close: async () => {
        await reader.cancel();
      },
      [Symbol.asyncIterator]: () => sseEvents(reader),
    };
  }

  private async post(
    path: string,
    payload: unknown,
    costTags?: Record<string, string>,
  ): Promise<globalThis.Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let bearer = this.opts.apiKey ?? "";
    if (this.opts.tokenSource) {
      bearer = await this.opts.tokenSource();
    }
    if (bearer) {
      headers["Authorization"] = `Bearer ${bearer}`;
    }
    // An empty per-call map carries no tags, so it means "no per-call
    // tags" and defers to the client default, like omitting the field.
    // A caller that builds tags dynamically otherwise loses the default
    // silently, and cost attribution disappears without an error.
    const perCall = costTags && Object.keys(costTags).length > 0 ? costTags : undefined;
    const tags = formatCostTags(perCall ?? this.opts.costTags);
    if (tags) {
      headers[COST_TAG_HEADER] = tags;
    }
    const resp = await this.fetchFn(this.baseURL + path, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw await decodeError(resp);
    }
    return resp;
  }
}

function parseLoss(resp: globalThis.Response): string[] {
  const v = resp.headers.get(LOSS_HEADER);
  if (!v) {
    return [];
  }
  // The RFC 9110 list production permits OWS around commas and empty elements a
  // recipient must ignore, so trim every element and drop the empty ones.
  return v
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
}

async function decodeError(resp: globalThis.Response): Promise<LuxError> {
  const raw = await resp.text();
  try {
    const wire = JSON.parse(raw) as {
      error?: { type?: string; message?: string; request_id?: string };
    };
    const e = wire.error;
    if (e && (e.type || e.message)) {
      return new LuxError(resp.status, e.type ?? "", e.message ?? "", e.request_id ?? "");
    }
  } catch {
    // fall through to the opaque form
  }
  return new LuxError(resp.status, "", raw.trim());
}

const VALID_EVENTS = new Set<string>([
  "message_start",
  "block_start",
  "text_delta",
  "args_delta",
  "thinking_delta",
  "signature_delta",
  "block_stop",
  "message_delta",
  "message_stop",
]);

/** Parse the lux SSE stream (the IR event grammar) into events.
 * Unknown event names are skipped (forward compatibility); an
 * `event: error` frame throws LuxStreamError. */
async function* sseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<LuxEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let eof = false;
  let frame: string[] = [];

  // One complete line, or null when the buffer holds only a partial one.
  // Line terminators are CR, LF, or CRLF; a trailing CR is held back
  // until more input arrives, since the LF of a CRLF pair can land in
  // the next chunk.
  const takeLine = (): string | null => {
    const i = buf.search(/[\r\n]/);
    if (i < 0) {
      return null;
    }
    const line = buf.slice(0, i);
    if (buf[i] === "\r") {
      if (i + 1 === buf.length && !eof) {
        return null;
      }
      buf = buf.slice(buf[i + 1] === "\n" ? i + 2 : i + 1);
    } else {
      buf = buf.slice(i + 1);
    }
    return line;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        eof = true;
      } else {
        buf += decoder.decode(value, { stream: true });
      }
      for (;;) {
        const line = takeLine();
        if (line === null) {
          break;
        }
        // A blank line closes the frame; frames yield as they complete,
        // never buffered to the end of the stream.
        if (line === "") {
          const ev = parseFrame(frame);
          frame = [];
          if (ev !== null) {
            yield ev;
          }
          continue;
        }
        frame.push(line);
      }
      if (eof) {
        break;
      }
    }
    // A final unterminated frame still parses (stream cut early).
    if (buf !== "") {
      frame.push(buf);
    }
    if (frame.length > 0) {
      const ev = parseFrame(frame);
      if (ev !== null) {
        yield ev;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseFrame(lines: string[]): LuxEvent | null {
  let name = "";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) {
      continue; // comment / keep-alive
    }
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const d = line.slice(5);
      dataLines.push(d.startsWith(" ") ? d.slice(1) : d);
    }
  }
  const data = dataLines.join("\n");
  if (name === "error") {
    try {
      const wire = JSON.parse(data) as { error?: { type?: string; message?: string } };
      const e = wire.error;
      if (e && (e.type || e.message)) {
        throw new LuxStreamError(e.type ?? "", e.message ?? "");
      }
    } catch (err) {
      if (err instanceof LuxStreamError) {
        throw err;
      }
    }
    throw new LuxStreamError("", data);
  }
  if (!VALID_EVENTS.has(name)) {
    return null;
  }
  let ev: LuxEvent;
  try {
    ev = JSON.parse(data) as LuxEvent;
  } catch {
    // A producer that emits a truncated or non-JSON payload is a stream
    // fault, not a caller error: surface it typed rather than leaking a
    // raw SyntaxError out of the iterator.
    throw new LuxStreamError("", `malformed ${name} payload: ${data}`);
  }
  if (!ev.type) {
    ev.type = name as EventType;
  }
  return ev;
}
