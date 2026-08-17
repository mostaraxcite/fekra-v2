/**
 * SSE event mapper — maps SDK session events to SSE events for the client.
 * Also exports ChannelTokenRouter for model thinking/reasoning tag parsing.
 */

import { sanitizeText, stripServerPaths, friendlyToolResult, inferToolSuccess } from "./tool-messages.js";

export interface SSEEvent {
  type: string;
  data: unknown;
}

export type ChunkType = "text" | "thinking" | "tool";

/**
 * Stateful parser for model thinking markers and tool call tags.
 *
 * Supports ALL known model thinking/reasoning tag formats:
 * 1. Gemma 4:              `<|channel>thought\n...\n<channel>\n` or `<|channel|>thought`
 * 2. DeepSeek-R1/Qwen3/Llama: `<think>\n...\n</think>`
 * 3. DeepSeek distilled:   (may omit opening `<think>`, only emit `</think>` at end)
 * 4. Claude (prompted):    `<rationale>\n...\n</rationale>`
 * 5. Tool Calls (XML):     `<function name="...">...</function>`
 *
 * Because streaming delivers tokens one at a time, the markers may be split
 * across multiple delta events. This class buffers partial markers and routes
 * content between them as `thinking` or `tool` instead of `text_delta`.
 *
 * Usage: one instance per streaming session.
 */
export class ChannelTokenRouter {
  /** True when we're inside a thinking block */
  private inThinking = false;
  /** True when we're inside a tool call block */
  private inTool = false;
  /** True while suppressing leaked DeepSeek DSML tool protocol. */
  private inDsmlTool = false;
  /** Buffer for potential partial opening/closing markers */
  private buffer = "";
  /** Track whether any text has been emitted yet (for distilled model detection) */
  private hasEmittedText = false;

  // ── Regex patterns for markers ──────────────────────────────────────
  private static THINK_OPEN_RE = /<think>|<rationale>|<\|?channel\|?>thought/i;
  private static THINK_CLOSE_RE = /<\/think>|<\/rationale>|<\|?channel\|?>/i;
  private static TOOL_OPEN_RE = /<function\b[^>]*>/i;
  private static TOOL_CLOSE_RE = /<\/function>/i;
  private static DSML_OPEN_RE = /<[|｜]DSML[|｜](?:function_calls|tool_calls)\b[^>\n]*>?/i;
  private static DSML_CLOSE_RE = /<\/[|｜]DSML[|｜](?:function_calls|tool_calls)\s*>/i;

  // Includes the full-width pipe used by DeepSeek DSML plus underscores,
  // so split protocol markers are buffered instead of leaking token-by-token.
  private static PARTIAL_MARKER_RE = /<(?:\/?[a-z0-9_|｜!:\-]*|[|｜]?[a-z0-9_|｜!:\-]*)$/i;

  private static ANSWER_RE = /<\/?answer>/gi;

  /**
   * Process a delta token and return categorized chunks.
   * Returns array of { type: ChunkType, content: string }
   */
  process(delta: string): Array<{ type: ChunkType; content: string }> {
    const results: Array<{ type: ChunkType; content: string }> = [];
    const input = this.buffer + delta;
    this.buffer = "";

    let remaining = input.replace(ChannelTokenRouter.ANSWER_RE, "");

    while (remaining.length > 0) {
      if (this.inDsmlTool) {
        const closeIdx = remaining.search(ChannelTokenRouter.DSML_CLOSE_RE);
        if (closeIdx === -1) {
          // Discard DSML body. Preserve only a trailing partial marker so a
          // split closing token can be recognized on the next delta.
          const trailing = remaining.match(ChannelTokenRouter.PARTIAL_MARKER_RE);
          this.buffer = trailing?.[0] ?? "";
          remaining = "";
        } else {
          const match = remaining.slice(closeIdx).match(ChannelTokenRouter.DSML_CLOSE_RE);
          remaining = remaining.slice(closeIdx + (match ? match[0].length : 1));
          if (remaining.startsWith("\n")) remaining = remaining.slice(1);
          this.inDsmlTool = false;
        }
      } else if (this.inThinking) {
        const closeIdx = remaining.search(ChannelTokenRouter.THINK_CLOSE_RE);
        if (closeIdx === -1) {
          remaining = this.handlePartial(remaining, ChannelTokenRouter.THINK_CLOSE_RE, "thinking", results);
        } else {
          const before = remaining.slice(0, closeIdx);
          if (before) results.push({ type: "thinking", content: before });
          const match = remaining.slice(closeIdx).match(ChannelTokenRouter.THINK_CLOSE_RE);
          remaining = remaining.slice(closeIdx + (match ? match[0].length : 1));
          if (remaining.startsWith("\n")) remaining = remaining.slice(1);
          this.inThinking = false;
        }
      } else if (this.inTool) {
        const closeIdx = remaining.search(ChannelTokenRouter.TOOL_CLOSE_RE);
        if (closeIdx === -1) {
          remaining = this.handlePartial(remaining, ChannelTokenRouter.TOOL_CLOSE_RE, "tool", results);
        } else {
          const before = remaining.slice(0, closeIdx);
          if (before) results.push({ type: "tool", content: before });
          const match = remaining.slice(closeIdx).match(ChannelTokenRouter.TOOL_CLOSE_RE);
          remaining = remaining.slice(closeIdx + (match ? match[0].length : 1));
          if (remaining.startsWith("\n")) remaining = remaining.slice(1);
          this.inTool = false;
        }
      } else {
        // Look for any opening tag or thinking close (for distilled models)
        const thinkOpenIdx = remaining.search(ChannelTokenRouter.THINK_OPEN_RE);
        const toolOpenIdx = remaining.search(ChannelTokenRouter.TOOL_OPEN_RE);
        const dsmlOpenIdx = remaining.search(ChannelTokenRouter.DSML_OPEN_RE);
        const thinkOrphanCloseIdx = remaining.search(ChannelTokenRouter.THINK_CLOSE_RE);

        // Priority 0: leaked DeepSeek DSML is internal protocol, never UI text.
        if (dsmlOpenIdx !== -1 && (thinkOpenIdx === -1 || dsmlOpenIdx < thinkOpenIdx) && (toolOpenIdx === -1 || dsmlOpenIdx < toolOpenIdx)) {
          const before = remaining.slice(0, dsmlOpenIdx);
          if (before) {
            results.push({ type: "text", content: before });
            this.hasEmittedText = true;
          }
          const match = remaining.slice(dsmlOpenIdx).match(ChannelTokenRouter.DSML_OPEN_RE);
          remaining = remaining.slice(dsmlOpenIdx + (match ? match[0].length : 1));
          if (remaining.startsWith("\n")) remaining = remaining.slice(1);
          this.inDsmlTool = true;
        }
        // Priority 1: Tool Open
        else if (toolOpenIdx !== -1 && (thinkOpenIdx === -1 || toolOpenIdx < thinkOpenIdx)) {
          const before = remaining.slice(0, toolOpenIdx);
          if (before) {
            results.push({ type: "text", content: before });
            this.hasEmittedText = true;
          }
          const match = remaining.slice(toolOpenIdx).match(ChannelTokenRouter.TOOL_OPEN_RE);
          const rawMatch = match ? match[0] : "";
          // Emit the opening tag itself as 'tool' type so the UI knows which tool started
          results.push({ type: "tool", content: rawMatch });
          remaining = remaining.slice(toolOpenIdx + rawMatch.length);
          if (remaining.startsWith("\n")) remaining = remaining.slice(1);
          this.inTool = true;
        }
        // Priority 2: Thinking Open
        else if (thinkOpenIdx !== -1) {
          const before = remaining.slice(0, thinkOpenIdx);
          if (before) {
            results.push({ type: "text", content: before });
            this.hasEmittedText = true;
          }
          const match = remaining.slice(thinkOpenIdx).match(ChannelTokenRouter.THINK_OPEN_RE);
          remaining = remaining.slice(thinkOpenIdx + (match ? match[0].length : 1));
          if (remaining.startsWith("\n")) remaining = remaining.slice(1);
          this.inThinking = true;
        }
        // Priority 3: Orphan Thinking Close (Distilled models like DeepSeek)
        else if (thinkOrphanCloseIdx !== -1 && !this.hasEmittedText) {
          const before = remaining.slice(0, thinkOrphanCloseIdx);
          if (before) results.push({ type: "thinking", content: before });
          const match = remaining.slice(thinkOrphanCloseIdx).match(ChannelTokenRouter.THINK_CLOSE_RE);
          remaining = remaining.slice(thinkOrphanCloseIdx + (match ? match[0].length : 1));
          if (remaining.startsWith("\n")) remaining = remaining.slice(1);
        }
        // Default: Text
        else {
          const partialMatch = remaining.match(ChannelTokenRouter.PARTIAL_MARKER_RE);
          if (partialMatch && partialMatch.index !== undefined) {
            const before = remaining.slice(0, partialMatch.index);
            if (before) {
              results.push({ type: "text", content: before });
              this.hasEmittedText = true;
            }
            this.buffer = partialMatch[0];
          } else {
            if (remaining) {
              results.push({ type: "text", content: remaining });
              this.hasEmittedText = true;
            }
          }
          remaining = "";
        }
      }
    }

    return results;
  }

  private handlePartial(remaining: string, closeRe: RegExp, type: ChunkType, results: any[]): string {
    const trailingMatch = remaining.match(ChannelTokenRouter.PARTIAL_MARKER_RE);
    if (trailingMatch && trailingMatch.index !== undefined) {
      const before = remaining.slice(0, trailingMatch.index);
      if (before) results.push({ type, content: before });
      this.buffer = trailingMatch[0];
      return "";
    } else {
      results.push({ type, content: remaining });
      return "";
    }
  }

  /** Flush any buffered content at stream end */
  flush(): Array<{ type: ChunkType; content: string }> {
    if (!this.buffer) return [];
    const content = this.buffer;
    this.buffer = "";
    if (this.inDsmlTool || /[|｜]DSML[|｜]/i.test(content)) return [];
    const type = this.inThinking ? "thinking" : this.inTool ? "tool" : "text";
    return [{ type, content }];
  }
}


export function mapEventToSSE(event: Record<string, unknown>): SSEEvent | null {
  const type = event.type as string;
  const data = event.data as Record<string, unknown> | undefined;

  switch (type) {
    // ─── Streaming text deltas (token-by-token from SDK) ──
    case "assistant.message_delta": {
      const delta = (data?.deltaContent ?? "") as string;
      if (!delta) return null;
      return { type: "text_delta", data: sanitizeText(delta) };
    }

    // ─── SDK v0.2.0 streaming delta (raw text chunks) ────
    case "assistant.streaming_delta": {
      const streamDelta = (data?.deltaContent ?? data?.content ?? data?.delta ?? "") as string;
      if (!streamDelta) return null;
      return { type: "text_delta", data: sanitizeText(streamDelta) };
    }

    // ─── Final complete message (sent after streaming ends) ─
    case "assistant.message":
      return null;

    // ─── Legacy / direct provider text events ─────────────
    case "text_delta": {
      const raw = (data?.content ?? data ?? "") as string;
      return { type: "text_delta", data: sanitizeText(String(raw)) };
    }

    // ─── Streaming reasoning deltas (token-by-token thinking) ──
    case "assistant.reasoning_delta": {
      const reasoningDelta = (data?.deltaContent ?? "") as string;
      if (!reasoningDelta) return null;
      return { type: "thinking", data: sanitizeText(stripServerPaths(reasoningDelta)) };
    }

    // ─── Final reasoning block ────────────────────────────
    case "assistant.reasoning":
      return null;

    // ─── Thinking / reasoning (legacy events) ─────────────
    case "assistant.thinking":
      return { type: "thinking", data: sanitizeText(stripServerPaths(String(data?.content ?? ""))) };

    // ─── Tool calls (starting) ────────────────────────────
    case "tool.running":
    case "tool.execution_start":
    case "external_tool.requested": {
      const startToolName = (data?.toolName ?? data?.name) as string | undefined;
      if (!startToolName) return null;
      // Unwrap SDK envelope { toolName, arguments: {...real args...}, toolCallId }
      const rawStartArgs = (data?.arguments ?? data?.args ?? data?.input) as
        | Record<string, unknown>
        | undefined;
      const startArgs = (rawStartArgs && typeof (rawStartArgs as { arguments?: unknown }).arguments === "object")
        ? (rawStartArgs as { arguments: Record<string, unknown> }).arguments
        : rawStartArgs;
      const startPath = (startArgs?.path ?? startArgs?.filePath ?? startArgs?.file ?? startArgs?.target) as string | undefined;
      return {
        type: "tool_call",
        data: {
          name: startToolName,
          ...(startArgs ? { arguments: startArgs } : {}),
          ...(startPath ? { path: startPath } : {}),
        },
      };
    }

    // ─── Tool results (completed) ─────────────────────────
    case "tool.completed":
    case "tool.execution_complete": {
      const resultToolName = (data?.toolName ?? data?.name) as string;
      const toolResult = data?.result as Record<string, unknown> | undefined;
      // Some SDK channels wrap the request args under .arguments
      // ({ toolName, arguments: {...real args...}, toolCallId }); unwrap so
      // the client sees the user-facing path/command fields.
      const rawReqArgs = (data?.arguments ?? data?.args ?? data?.input) as
        | Record<string, unknown>
        | undefined;
      const reqArgs = (rawReqArgs && typeof (rawReqArgs as { arguments?: unknown }).arguments === "object")
        ? (rawReqArgs as { arguments: Record<string, unknown> }).arguments
        : rawReqArgs;
      const reqPath = (reqArgs?.path ?? reqArgs?.filePath ?? reqArgs?.file ?? reqArgs?.target) as string | undefined;
      const effectiveSuccess = inferToolSuccess(data?.result, data?.success);
      return {
        type: "tool_result",
        data: {
          name: resultToolName,
          success: effectiveSuccess,
          friendlyMessage: friendlyToolResult(resultToolName, data?.result, effectiveSuccess),
          // Pass through request args so the client can label cards with the
          // correct file name (BUG: "Reading file" instead of "Reading App.tsx").
          ...(reqArgs ? { args: reqArgs } : {}),
          // Diff metadata for file-editing tools
          path:         (toolResult?.path as string  | undefined) ?? reqPath,
          linesAdded:   toolResult?.linesAdded   as number  | undefined,
          linesRemoved: toolResult?.linesRemoved as number  | undefined,
        },
      };
    }
    case "external_tool.completed":
      return null;

    // ─── Errors ───────────────────────────────────────────
    case "session.error": {
      const rawMsg = String(data?.message ?? data?.errorType ?? "Unknown error");
      const statusCode = data?.statusCode as number | undefined;
      let userMsg: string;
      if (statusCode === 404 || rawMsg.includes("404")) {
        userMsg = "The AI model is unavailable (404). Check your model ID and provider settings.";
      } else if (statusCode === 401 || rawMsg.includes("unauthorized") || rawMsg.includes("not authorized")) {
        userMsg = "Authentication failed with the AI provider. Check your API key.";
      } else if (statusCode === 429 || statusCode === 503 || rawMsg.includes("rate limit") || rawMsg.includes("rate_limit") || rawMsg.includes("quota")) {
        userMsg = `⚠️ Rate limit exceeded — the AI provider is rejecting requests due to too many calls. Please wait a minute before trying again, or switch to a different model in AI Settings. (Provider error: ${rawMsg.slice(0, 200)})`;
      } else {
        userMsg = sanitizeText(rawMsg);
      }
      return { type: "error", data: userMsg };
    }

    // ─── Done ─────────────────────────────────────────────
    case "session.idle":
    case "done":
      return { type: "done", data: {} };

    // ─── Skip noise events ────────────────────────────────
    case "pending_messages.modified":
    case "session.tools_updated":
    case "session.usage_info":
    case "session.background_tasks_changed":
    case "session.custom_agents_updated":
    case "tool.execution_partial_result":
    case "assistant.usage":
    case "hook.start":
    case "hook.end":
    case "user.message":
    case "assistant.turn_start":
    case "assistant.turn_end":
    case "permission.requested":
    case "permission.completed":
    case "model_call":
    case "model_call.start":
    case "model_call.end":
      return null;

    default:
      console.debug(`[mapEventToSSE] unhandled event type: ${type}`);
      return null;
  }
}
