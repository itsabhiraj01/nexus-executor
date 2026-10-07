/**
 * Minimal OpenCode V2 HTTP client plus message normalization — copied from
 * the hub's `modules/builder/src/opencode.ts` and made standalone: the
 * `@nexus/telemetry` tracing spans are removed (plain fetch, the injectable
 * `fetchImpl` stays) and the `./models.js` import is inlined below as a
 * minimal `ModelRef` + `normalizeModels`.
 *
 * The client only covers what the executor needs: create a session, send a
 * prompt into the SAME session (resume semantics), read messages back,
 * interrupt, and list models. Event capture is polling-based on purpose: the
 * messages endpoint already exposes assistant text, tool calls with terminal
 * states, errors and token usage, so the engine never assumes SSE fields
 * exist.
 */

/** A model reference as OpenCode addresses it: provider plus model id. */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** One model, normalized from `GET /api/model`. */
export interface OpenCodeModelInfo {
  id: string;
  name: string;
  provider: string;
}

/** Raw model entry from `GET /api/model` — only the fields we read. */
interface RawOpenCodeModel {
  id?: unknown;
  name?: unknown;
  providerID?: unknown;
  provider?: unknown;
}

/** Map raw service rows → `{id, name, provider}`; entries without a usable
 *  id are dropped. Sorted by provider then name for stable pickers. */
export function normalizeModels(data: readonly RawOpenCodeModel[]): OpenCodeModelInfo[] {
  const out: OpenCodeModelInfo[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) continue;
    const provider = typeof raw.providerID === 'string' && raw.providerID.trim()
      ? raw.providerID.trim()
      : typeof raw.provider === 'string'
        ? raw.provider.trim()
        : '';
    out.push({ id, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id, provider });
  }
  out.sort((a, b) => a.provider === b.provider ? a.name.localeCompare(b.name) : a.provider.localeCompare(b.provider));
  return out;
}

/**
 * Parse `provider/model` back into a ref (null when malformed). The FIRST
 * slash splits provider from model — model ids may themselves contain
 * slashes; provider ids may not.
 */
export function parseModelRef(value: string): ModelRef | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const providerID = trimmed.slice(0, slash).trim();
  const modelID = trimmed.slice(slash + 1).trim();
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

export interface OpenCodeClientConfig {
  baseUrl: string;
  token?: string | null;
  agent?: string | null;
  fetchImpl?: typeof fetch;
}

export class OpenCodeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * OpenCode V2 `serve` instances authenticate over HTTP Basic: username
 * `opencode`, password = the server's password (pin it on the service with
 * OPENCODE_SERVER_PASSWORD so it survives restarts). A token that already
 * carries an auth scheme ("Basic …", "Bearer …") is passed through verbatim,
 * which covers gateway fronts in front of the server.
 */
function authHeader(token: string): { authorization: string } {
  if (/^(basic|bearer)\s/i.test(token)) return { authorization: token };
  return { authorization: `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}` };
}

export interface OpenCodeTextPart {
  type: 'text';
  text: string;
}
export interface OpenCodeToolPart {
  type: 'tool';
  tool?: string;
  state?: { status?: string; input?: unknown; content?: unknown; output?: unknown; metadata?: unknown; error?: unknown };
  /** Part lifecycle timestamps (ms since epoch), as the live API reports them. */
  time?: { ran?: number; completed?: number };
}
export type OpenCodePart = OpenCodeTextPart | OpenCodeToolPart | { type: string };
export interface OpenCodeMessage {
  id: string;
  type?: string;
  agent?: string;
  model?: { id?: string; providerID?: string };
  content?: OpenCodePart[];
  finish?: string | null;
  error?: OpenCodeMessageError | null;
  time?: { created?: number; completed?: number };
  tokens?: { input?: number; output?: number } | null;
  /** `agent-switched` markers carry the target and previous agent. */
  previous?: string;
  /** `idle` markers carry the turn outcome (`succeeded` / `failed` / …). */
  outcome?: string;
}

/** Assistant errors arrive as plain strings or structured objects ({type, status, message}). */
export type OpenCodeMessageError = string | { type?: unknown; status?: unknown; message?: unknown };

export interface OpenCodeSessionInfo {
  id: string;
  agent?: string;
  model?: { id?: string; providerID?: string };
  location?: { directory?: string } | null;
}

export function createOpenCodeClient(config: OpenCodeClientConfig) {
  const base = config.baseUrl.replace(/\/+$/, '');
  const doFetch = config.fetchImpl ?? fetch;
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(config.token ? authHeader(config.token) : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (cause) {
      throw new OpenCodeError(`OpenCode service unreachable at ${base}: ${String(cause)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OpenCodeError(`OpenCode ${path} failed: ${res.status} ${body.slice(0, 200)}`, res.status);
    }
    // Empty bodies are legal for void endpoints (204 No Content — the
    // session interrupt answers exactly that): parse only when something
    // arrived. Callers for those endpoints discard the value anyway.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  return {
    /**
     * Create a session. `directory` pins the session's project directory —
     * the OpenCode service otherwise derives it from its own working
     * directory, which is how parallel executions used to share one
     * checkout. Passing a git worktree path here is the isolation guarantee.
     */
    async createSession(input: {
      title: string; directory?: string | null; agent?: string | null; model?: ModelRef | null;
    }): Promise<OpenCodeSessionInfo> {
      const body: Record<string, unknown> = { title: input.title };
      const agent = input.agent ?? config.agent;
      if (agent) body.agent = agent;
      if (input.directory) body.location = { directory: input.directory };
      if (input.model) body.model = { providerID: input.model.providerID, id: input.model.modelID };
      const out = await request<{ data: OpenCodeSessionInfo }>('/api/session', { method: 'POST', body: JSON.stringify(body) });
      return out.data;
    },
    /**
     * Switch a session's model for subsequent turns (the usage-limit
     * fallback). The endpoint answers 204 with an empty body, so this must
     * not parse JSON.
     */
    async switchModel(sessionId: string, model: ModelRef): Promise<void> {
      const res = await doFetch(`${base}/api/session/${encodeURIComponent(sessionId)}/model`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.token ? authHeader(config.token) : {}),
        },
        body: JSON.stringify({ model: { providerID: model.providerID, id: model.modelID } }),
      }).catch((cause) => {
        throw new OpenCodeError(`OpenCode service unreachable at ${base}: ${String(cause)}`);
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new OpenCodeError(`OpenCode model switch failed: ${res.status} ${body.slice(0, 200)}`, res.status);
      }
    },
    /** The models the service's connected accounts offer. The live v2
     *  service accepts the flattened `?directory=` query form and returns
     *  `data: []` when no directory is passed — so callers should always
     *  provide one (the repo checkout). */
    async listModels(directory?: string | null): Promise<OpenCodeModelInfo[]> {
      const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const out = await request<{ location?: unknown; data?: RawOpenCodeModel[] }>(`/api/model${query}`);
      return normalizeModels(out.data ?? []);
    },
    async prompt(sessionId: string, text: string): Promise<{ id: string }> {
      const out = await request<{ data: { id: string } }>(
        `/api/session/${encodeURIComponent(sessionId)}/prompt`,
        { method: 'POST', body: JSON.stringify({ text }) },
      );
      return out.data;
    },
    async interrupt(sessionId: string): Promise<void> {
      await request(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST', body: '{}' });
    },
    async getMessages(sessionId: string): Promise<OpenCodeMessage[]> {
      const out = await request<{ data: OpenCodeMessage[] }>(`/api/session/${encodeURIComponent(sessionId)}/message`);
      return out.data ?? [];
    },
  };
}
export type OpenCodeClient = ReturnType<typeof createOpenCodeClient>;

export type NormalizedEventType =
  | 'AGENT_MESSAGE' | 'AGENT_ERROR' | 'AGENT_REASONING' | 'TOOL_CALL_STARTED' | 'TOOL_CALL_FINISHED'
  | 'TOOL_CALL_FAILED' | 'AGENT_SWITCHED' | 'MODEL_SWITCHED' | 'AGENT_IDLE' | 'AGENT_ASKED_USER';

export interface NormalizedEvent {
  eventType: NormalizedEventType;
  source: 'opencode';
  summary: string;
  payload: Record<string, unknown>;
  /** `${messageId}` for message-level events, `${messageId}:${partIndex}` for parts. */
  opencodeMessageId: string;
}

/**
 * Render an assistant error readably. The V2 API reports message-level
 * errors as structured objects (`{type: 'provider.auth', status: 401,
 * message: …}`) as well as plain strings — naive stringification produced
 * "[object Object]" timeline summaries, so extract the message and suffix
 * the type/status instead.
 */
export function agentErrorSummary(error: OpenCodeMessageError): string {
  if (typeof error === 'string') return error.slice(0, 200) || 'Agent error';
  const message = typeof error.message === 'string' && error.message
    ? error.message
    : JSON.stringify(error);
  const type = typeof error.type === 'string' ? error.type : '';
  const status = typeof error.status === 'number' ? ` ${error.status}` : '';
  return `${message}${type ? ` (${type}${status})` : ''}`.slice(0, 200) || 'Agent error';
}

/**
 * Normalize one OpenCode message into timeline events. User messages are
 * skipped — the executor records the prompts it sends itself (PROMPT_SENT /
 * HUB_MESSAGE), which keeps the timeline free of duplicates.
 *
 * Besides assistant turns, session-level markers are captured so mode drift
 * and turn outcomes stay visible: `agent-switched`, `model-switched` and
 * `idle` (turn end + outcome). Assistant `reasoning` parts become
 * AGENT_REASONING events — the agent's thinking chain.
 */
export function messageToEvents(message: OpenCodeMessage): NormalizedEvent[] {
  if (message.type === 'agent-switched') {
    return [{
      eventType: 'AGENT_SWITCHED',
      source: 'opencode',
      summary: `Agent switched: ${message.previous ?? '?'} → ${message.agent ?? '?'}`,
      payload: { from: message.previous ?? null, to: message.agent ?? null },
      opencodeMessageId: message.id,
    }];
  }
  if (message.type === 'model-switched') {
    return [{
      eventType: 'MODEL_SWITCHED',
      source: 'opencode',
      summary: `Model switched: ${message.previous ?? '?'} → ${message.model?.id ?? message.agent ?? '?'}`,
      payload: { from: message.previous ?? null, to: message.model ?? null, agent: message.agent ?? null },
      opencodeMessageId: message.id,
    }];
  }
  if (message.type === 'idle') {
    return [{
      eventType: 'AGENT_IDLE',
      source: 'opencode',
      summary: `Agent went idle (${message.outcome ?? 'unknown'})`,
      payload: { outcome: message.outcome ?? null },
      opencodeMessageId: message.id,
    }];
  }
  if (message.type !== 'assistant') return [];
  const events: NormalizedEvent[] = [];
  if (message.error) {
    events.push({
      eventType: 'AGENT_ERROR',
      source: 'opencode',
      summary: agentErrorSummary(message.error),
      payload: { error: message.error, finish: message.finish ?? null },
      opencodeMessageId: message.id,
    });
  }
  (message.content ?? []).forEach((part, index) => {
    const dedupeId = `${message.id}:${index}`;
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
      const text = part.text.trim();
      if (text) {
        events.push({
          eventType: 'AGENT_MESSAGE',
          source: 'opencode',
          summary: text.slice(0, 200),
          payload: { text },
          opencodeMessageId: dedupeId,
        });
      }
      return;
    }
    if (part.type === 'reasoning' && 'text' in part && typeof part.text === 'string') {
      const text = part.text.trim();
      if (text) {
        events.push({
          eventType: 'AGENT_REASONING',
          source: 'opencode',
          summary: text.slice(0, 200),
          payload: { text },
          opencodeMessageId: dedupeId,
        });
      }
      return;
    }
    if (part.type === 'tool') {
      const tool = part as OpenCodeToolPart;
      const name = tool.tool ?? 'tool';
      const status = tool.state?.status ?? 'completed';
      const payload = {
        tool: name,
        status,
        input: tool.state?.input ?? null,
        output: tool.state?.content ?? tool.state?.output ?? null,
        metadata: tool.state?.metadata ?? null,
        error: tool.state?.error ?? null,
      };
      if (status === 'error') {
        events.push({ eventType: 'TOOL_CALL_FAILED', source: 'opencode', summary: `${name} failed`, payload, opencodeMessageId: dedupeId });
      } else if (status === 'running' || status === 'streaming' || status === 'pending') {
        events.push({ eventType: 'TOOL_CALL_STARTED', source: 'opencode', summary: `${name} started`, payload, opencodeMessageId: dedupeId });
      } else {
        events.push({ eventType: 'TOOL_CALL_FINISHED', source: 'opencode', summary: `${name} finished`, payload, opencodeMessageId: dedupeId });
      }
    }
  });
  return events;
}

/**
 * True when an assistant message ended the agent's turn and every tool part
 * reached a terminal state. `finish='tool-calls'` means the model stopped to
 * run its tools and the turn CONTINUES (a follow-up assistant message comes
 * after the tools finish), so those intermediate turns must not promote or
 * verify — real turn ends carry `finish='stop'` (or `'error'`).
 */
export function messageComplete(message: OpenCodeMessage): boolean {
  if (message.type !== 'assistant' || !message.finish) return false;
  if (message.finish === 'tool-calls') return false;
  return (message.content ?? []).every((part) => {
    if (part.type !== 'tool') return true;
    const status = (part as OpenCodeToolPart).state?.status;
    return status !== 'running' && status !== 'streaming' && status !== 'pending';
  });
}

/**
 * True when a completed turn ended in an error — an aborted step (the
 * service's "Step interrupted" abort) or a provider failure. Such a turn
 * finished, but it is NOT done work: the engine fails the job instead of
 * promoting it, so interrupted work never reads as completed.
 */
export function turnErrored(message: OpenCodeMessage): boolean {
  if (!messageComplete(message)) return false;
  return message.error != null || message.finish === 'error';
}

/* ── Usage-limit detection + the fallback prompt (ported from the hub's
 *  modules/builder/src/models.ts — keep the heuristics in sync). ─────── */

const LIMIT_TYPE = /(rate.?limit|quota|usage|credit|billing|payment|capacity|overload)/i;
const LIMIT_MESSAGE = /\b(rate.?limit|quota|too many requests|usage limit|usage cap|credits?|billing|payment required|exceeded your (?:current )?(?:quota|limit)|insufficient|capacity|overloaded|temporarily over|try again later|429)\b/i;
const AUTH_ERROR = /\bauth\b|api.?key|unauthorized|forbidden|permission/i;

/**
 * Heuristic: did an assistant turn fail because the MODEL hit a usage limit?
 * Providers phrase this differently (429s, quota exhaustion, spent credits),
 * and OpenCode reports message errors either structured
 * (`{type:'provider.rate_limit', status:429, message:…}`) or as plain
 * strings. Auth/config failures (401/403, missing keys) are deliberately
 * excluded — switching models cannot fix a missing credential, and a
 * fallback would only hide the misconfiguration. Over-matching is cheap (a
 * model switch); under-matching degrades to the normal fail path.
 */
export function isModelLimitError(error: OpenCodeMessageError | null | undefined): boolean {
  if (error == null) return false;
  if (typeof error === 'string') return LIMIT_MESSAGE.test(error);
  const status = typeof error.status === 'number' ? error.status : null;
  const type = typeof error.type === 'string' ? error.type : '';
  if (status === 401 || status === 403) return false;
  if (type && AUTH_ERROR.test(type)) return false;
  if (status === 429 || status === 402) return true;
  if (type && LIMIT_TYPE.test(type)) return true;
  return typeof error.message === 'string' ? LIMIT_MESSAGE.test(error.message) : false;
}

/** The prompt sent after an automatic model fallback: the session carries
 *  the whole task history (including the failed turn's partial work), so
 *  the next model only needs to be told to pick the task up. */
export function fallbackPrompt(previous: string | null, next: string): string {
  return [
    previous
      ? `The model ${previous} hit its usage limit and could not finish the previous turn.`
      : 'The previous model hit its usage limit and could not finish the previous turn.',
    `You are now running as ${next}.`,
    '',
    'Continue the task above from where it stands — finish any incomplete work and end your turn with the usual summary.',
  ].join('\n');
}

/** The last non-empty text part of an assistant message, trimmed. */
export function finalAssistantText(message: OpenCodeMessage): string {
  if (message.type !== 'assistant') return '';
  let last = '';
  for (const part of message.content ?? []) {
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string' && part.text.trim()) {
      last = part.text.trim();
    }
  }
  return last;
}

/** Clear ask-phrases that park a turn for the user even without a question mark. */
const ASK_PHRASES = /\b(let me know|waiting for (?:your|the) (?:input|reply|response|answer|confirmation)|should (?:i|we) (?:proceed|continue|use|go with)|do you want me to|would you like me to|shall (?:i|we)|your call)\b/i;

/**
 * Heuristic: did the agent end its turn by asking the user something?
 * OpenCode V2 exposes no explicit needs-input signal in the polled message
 * list — a plan-mode or clarifying agent simply completes its turn with a
 * question — so a completed turn whose final text ends in a question mark
 * (or carries a clear ask phrase) is treated as waiting for the user.
 */
export function asksUserForInput(message: OpenCodeMessage): boolean {
  if (!messageComplete(message)) return false;
  const text = finalAssistantText(message);
  if (!text) return false;
  return /\?\s*$/.test(text) || ASK_PHRASES.test(text);
}

/**
 * The chronologically latest assistant message. The V2 message list arrives
 * NEWEST FIRST, so array position cannot be trusted — real messages carry
 * `time.created`, and the newest one wins regardless of list order. Lists
 * without timestamps degrade to the last assistant in array order
 * (chronological, as authored in tests).
 */
export function lastAssistant(messages: readonly OpenCodeMessage[]): OpenCodeMessage | null {
  let best: OpenCodeMessage | null = null;
  let bestAt = -Infinity;
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    const at = typeof message.time?.created === 'number' ? message.time.created : -Infinity;
    if (at >= bestAt) {
      best = message;
      bestAt = at;
    }
  }
  return best;
}

export interface StallCheckOptions {
  /** Wall clock to compare against (ms since epoch). */
  now: number;
  /** A single tool part may run this long before the job counts as stalled. */
  toolStallMs: number;
  /** An in-flight turn with nothing executing may sit silent this long. */
  silenceStallMs: number;
}

export interface StallResult {
  kind: 'tool' | 'silence' | 'no-progress';
  /** When the stalled activity started (ms since epoch). */
  since: number;
  /** Human-readable one-liner for events and notifications. */
  summary: string;
}

/**
 * Detect a wedged agent turn from the session's message list — the upstream
 * lost-tool-dispatch race (a tool part is marked running but never executes)
 * and its silent-model sibling. Two shapes:
 *
 * - `tool`: some tool part is still running/streaming/pending and its start
 *   (`time.ran`, falling back to the carrying message's creation) is older
 *   than `toolStallMs`. No API signal separates a wedged instant command
 *   from a legitimately long one, so the threshold doubles as the "no
 *   command should run this long" ceiling — keep it under the OpenCode
 *   service's 60-minute location-inactivity window, which kills such turns
 *   anyway.
 * - `silence`: the newest assistant turn is still in flight, nothing is
 *   executing anywhere in the session, and the newest message activity is
 *   older than `silenceStallMs`.
 *
 * Completed turns return null — the promotion, verification, ask-park and
 * fail-on-errored-turn paths own those.
 */
export function detectStall(
  messages: readonly OpenCodeMessage[],
  opts: StallCheckOptions,
): StallResult | null {
  if (messages.length === 0) return null;
  const last = lastAssistant(messages);
  if (last && messageComplete(last)) return null;

  const activeParts: Array<{ tool: OpenCodeToolPart; started: number | undefined }> = [];
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type !== 'tool') continue;
      const tool = part as OpenCodeToolPart;
      const status = tool.state?.status;
      if (status !== 'running' && status !== 'streaming' && status !== 'pending') continue;
      activeParts.push({ tool, started: tool.time?.ran ?? message.time?.created });
    }
  }
  if (opts.toolStallMs > 0) {
    for (const { tool, started } of activeParts) {
      if (typeof started !== 'number') continue;
      if (opts.now - started >= opts.toolStallMs) {
        const minutes = Math.round((opts.now - started) / 60_000);
        const command = toolCommandPreview(tool);
        return {
          kind: 'tool',
          since: started,
          summary: `a tool has been running for ${minutes} minute${minutes === 1 ? '' : 's'}${command ? ` (${command})` : ''} with no progress`,
        };
      }
    }
  }

  if (opts.silenceStallMs > 0 && activeParts.length === 0) {
    const newest = Math.max(...messages.map((message) => Math.max(
      message.time?.created ?? 0,
      message.time?.completed ?? 0,
    )));
    if (newest > 0 && opts.now - newest >= opts.silenceStallMs) {
      const minutes = Math.round((opts.now - newest) / 60_000);
      return {
        kind: 'silence',
        since: newest,
        summary: `no session activity for ${minutes} minute${minutes === 1 ? '' : 's'} while the turn is still in flight`,
      };
    }
  }
  return null;
}

/** First ~80 chars of a tool's command-ish input, for stall messages. */
function toolCommandPreview(tool: OpenCodeToolPart): string {
  const input = tool.state?.input as { command?: unknown } | undefined;
  const command = typeof input?.command === 'string' ? input.command : '';
  return command ? `'${command.slice(0, 80).replace(/\s+/g, ' ').trim()}'` : '';
}

/* ── Tool progress fingerprints ──────────────────────────────────────────
 *
 * The stall detector's absolute-age threshold (`toolStallMs`) doubles as a
 * "no command may run this long" ceiling because the messages API carries
 * no signal separating a wedged instant call (marked running, never
 * executes) from a legitimately long one. The tool state DOES carry
 * `output`/`content`/`error`, so watching those across checks gives the
 * missing signal: output growth means alive, a frozen fingerprint means
 * wedged. The engine persists the observed fingerprints on
 * `jobs.metadata.toolFingerprints` between checks and fails a job whose
 * active tool shows no progress for `toolProgressMs`.
 */

/** A cheap deterministic fingerprint of one value: length + tail hash. The
 *  length catches appends; the tail hash catches in-place edits and the
 *  capped/rotating-output tools whose length stops growing once full. */
function fingerprintValue(value: unknown): string {
  if (value === undefined || value === null) return '-';
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  } catch {
    return '?';
  }
  if (!text) return '-';
  let hash = 0;
  const tail = text.slice(-256);
  for (let index = 0; index < tail.length; index++) {
    hash = ((hash << 5) - hash + tail.charCodeAt(index)) | 0;
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/** The fingerprint compared across checks for one active tool part. */
export function toolFingerprint(part: OpenCodeToolPart): string {
  const state = part.state ?? {};
  return [
    state.status ?? '',
    fingerprintValue(state.output),
    fingerprintValue(state.content),
    fingerprintValue(state.error),
  ].join('|');
}

/** One live tool part's progress facts, as seen at one check. */
export interface ToolProgressInfo {
  /** The part's visible-progress fingerprint (status + output + error). */
  fingerprint: string;
  /** When the tool started (ms), `time.ran` or the message's creation. */
  startedAt?: number;
  /** Tool name plus a short command preview, for human summaries. */
  label: string;
  /** Any visible `output`/`content`/`error` at all. A wedged-from-birth
   *  call (marked running, never executed) has none. */
  hasOutput: boolean;
}

function toolHasVisibleOutput(part: OpenCodeToolPart): boolean {
  const state = part.state ?? {};
  for (const value of [state.output, state.content, state.error]) {
    if (value === undefined || value === null) continue;
    try {
      if (typeof value === 'string') {
        if (value !== '') return true;
      } else if (JSON.stringify(value)) {
        return true;
      }
    } catch {
      return true; // unserializable counts as present
    }
  }
  return false;
}

/** Every active (running/streaming/pending) tool part, keyed
 *  `messageId:partIndex`. */
export function collectToolProgress(messages: readonly OpenCodeMessage[]): Map<string, ToolProgressInfo> {
  const parts = new Map<string, ToolProgressInfo>();
  for (const message of messages) {
    const content = message.content ?? [];
    content.forEach((part, index) => {
      if (part.type !== 'tool') return;
      const tool = part as OpenCodeToolPart;
      const status = tool.state?.status;
      if (status !== 'running' && status !== 'streaming' && status !== 'pending') return;
      const preview = toolCommandPreview(tool);
      parts.set(`${message.id}:${index}`, {
        fingerprint: toolFingerprint(tool),
        startedAt: tool.time?.ran ?? message.time?.created,
        label: `${tool.tool ?? 'tool'}${preview ? ` ${preview}` : ''}`,
        hasOutput: toolHasVisibleOutput(tool),
      });
    });
  }
  return parts;
}

/** One tool part's last observed fingerprint, persisted between checks. */
export interface ToolProgressRecord {
  fingerprint: string;
  /** When the fingerprint last CHANGED (ms since epoch) — aging starts here. */
  changedAt: number;
}

/** The no-progress watch store: part key → last observed fingerprint. */
export type ToolProgressStore = Record<string, ToolProgressRecord>;

/** Read the metadata mirror (tolerates legacy/foreign shapes). */
export function readToolFingerprints(metadata: Record<string, unknown> | null | undefined): ToolProgressStore {
  const raw = metadata?.toolFingerprints;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const store: ToolProgressStore = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record.fingerprint !== 'string' && typeof record.fingerprint !== 'undefined') continue;
    if (typeof record.changedAt !== 'number') continue;
    store[key] = { fingerprint: String(record.fingerprint), changedAt: record.changedAt };
  }
  return store;
}

/**
 * No-progress evaluation across one poll/check: compares the active tool
 * parts' fingerprints with the persisted store, and returns both the store
 * to persist next and a stall when any active part has not visibly
 * progressed for `toolProgressMs`.
 *
 * Clock semantics:
 *
 * - a part whose fingerprint CHANGED since last check restarts its clock
 *   at now (progress — the whole point of the check);
 * - an UNCHANGED part keeps its `changedAt`; crossing the threshold fails
 *   with kind `no-progress`;
 * - a NEW part (first sight) cannot be proven stagnant, so its clock
 *   starts at now — with one exception: a part already older than the
 *   threshold that still has ZERO visible output matches the wedge's exact
 *   signature (a call marked running that never executed), so it fails on
 *   first sight instead of waiting another full threshold;
 * - parts that finished (or vanished) drop out of the store.
 */
export function evaluateToolProgress(
  active: Map<string, ToolProgressInfo>,
  stored: ToolProgressStore,
  opts: { now: number; toolProgressMs: number },
): { store: ToolProgressStore; stalled: StallResult | null } {
  const store: ToolProgressStore = {};
  let stalled: StallResult | null = null;
  for (const [key, info] of active) {
    const prior = stored[key];
    if (prior && prior.fingerprint === info.fingerprint) {
      store[key] = prior;
      if (!stalled && opts.toolProgressMs > 0 && opts.now - prior.changedAt >= opts.toolProgressMs) {
        const minutes = Math.round((opts.now - prior.changedAt) / 60_000);
        stalled = {
          kind: 'no-progress',
          since: prior.changedAt,
          summary: `no output from ${info.label} for ${minutes} minute${minutes === 1 ? '' : 's'} — the call never executed`,
        };
      }
      continue;
    }
    store[key] = { fingerprint: info.fingerprint, changedAt: opts.now };
    if (
      !stalled && opts.toolProgressMs > 0 && !info.hasOutput
      && typeof info.startedAt === 'number' && opts.now - info.startedAt >= opts.toolProgressMs
    ) {
      const minutes = Math.round((opts.now - info.startedAt) / 60_000);
      stalled = {
        kind: 'no-progress',
        since: info.startedAt,
        summary: `a tool has been running for ${minutes} minute${minutes === 1 ? '' : 's'} with zero output (${info.label}) — the call never executed`,
      };
    }
  }
  return { store, stalled };
}
