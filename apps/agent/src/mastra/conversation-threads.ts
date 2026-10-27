// The server's own record of each chat conversation: the one history the model is ever given.
//
// The browser used to resend the whole conversation on every message and the server handed it to the model as it
// arrived, so a customer could forge earlier turns (a fake system instruction, fake agent statements, fake tool results)
// and those also fed the transcript a rep reads and the reply fact-checker. Now the browser only supplies the newest
// message (chat-input.ts cleans it); everything older comes from here. The assistant's own replies, tool calls and tool
// results are written by the server from the stream it produced, and so are the notices it pushes (case-notices.ts).
//
// Messages are stored in the same UIMessage shape the browser held, so everything that reads a history (the order scan, the
// transcript builder, the case-sync rebuild) works on it unchanged. One row per conversation in the same LibSQL file as the
// workflow runs (AGENT_DB_URL), bound to the session that created it.

import { randomUUID } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import { createKeyedLock } from "./keyed-lock";

// A conversation longer than this is asked to start a new chat (the route enforces it). It bounds what one thread can cost.
export const MAX_THREAD_MESSAGES = 200;

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  parts: unknown[];
  // On a customer message: the id the browser gave it. "Try again" names the message it retries by this id, so the server can
  // tell a message it stored from one that never arrived. Never given to the model.
  clientId?: string;
}

export interface Thread {
  conversationId: string;
  sessionId: string;
  customerId: string;
  messages: StoredMessage[];
}

const threadLocks = createKeyedLock();

// Serializes every read-modify-write of one conversation: a turn finishing, a rep's notice arriving and the next message
// can all touch the same thread within milliseconds.
export function withThreadLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  return threadLocks.withLock(conversationId, fn);
}

let client: Client | undefined;
let clientUrl: string | undefined;
let tableReady: Promise<unknown> | undefined;

// Created lazily and keyed on AGENT_DB_URL, so a test that points the env at a temp database gets its own table.
async function db(): Promise<Client> {
  const url = process.env.AGENT_DB_URL ?? "file:./mastra.db";
  if (!client || clientUrl !== url) {
    const created = createClient({ url });
    client = created;
    clientUrl = url;
    tableReady = (async () => {
      await created.execute("PRAGMA busy_timeout = 5000");
      await created.execute(
        `CREATE TABLE IF NOT EXISTS wismo_threads (
          conversation_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          customer_id TEXT NOT NULL,
          messages TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      );
      await created.execute("CREATE INDEX IF NOT EXISTS wismo_threads_session ON wismo_threads (session_id, updated_at)");
    })();
  }
  await tableReady;
  return client;
}

export async function getThread(conversationId: string): Promise<Thread | undefined> {
  const result = await (await db()).execute({ sql: "SELECT conversation_id, session_id, customer_id, messages FROM wismo_threads WHERE conversation_id = ?", args: [conversationId] });
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    conversationId: String(row.conversation_id),
    sessionId: String(row.session_id),
    customerId: String(row.customer_id),
    messages: JSON.parse(String(row.messages)) as StoredMessage[],
  };
}

export async function saveThread(thread: Thread): Promise<void> {
  await (await db()).execute({
    sql: `INSERT INTO wismo_threads (conversation_id, session_id, customer_id, messages, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
    args: [thread.conversationId, thread.sessionId, thread.customerId, JSON.stringify(thread.messages), new Date().toISOString()],
  });
}

// Appends one message to an existing thread. A no-op when the thread does not exist (nothing to attach it to).
export async function appendToThread(conversationId: string, message: StoredMessage): Promise<void> {
  await withThreadLock(conversationId, async () => {
    const thread = await getThread(conversationId);
    if (!thread) return;
    thread.messages.push(message);
    await saveThread(thread);
  });
}

// The session's most recently used conversation: where a notice the SERVER pushes (a rep's decision, a follow-up question) lands,
// because that is where the browser shows it too. A session with no thread (the demo seed's "seed" sentinel, or a tab that never
// sent a message) has none.
export async function latestConversationIdOfSession(sessionId: string): Promise<string | undefined> {
  const result = await (await db()).execute({ sql: "SELECT conversation_id FROM wismo_threads WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1", args: [sessionId] });
  const conversationId = result.rows[0]?.conversation_id;
  return typeof conversationId === "string" ? conversationId : undefined;
}

// Appends several messages in one step. A no-op when the thread does not exist.
export async function appendManyToThread(conversationId: string, messages: StoredMessage[]): Promise<void> {
  await withThreadLock(conversationId, async () => {
    const thread = await getThread(conversationId);
    if (!thread) return;
    thread.messages.push(...messages);
    await saveThread(thread);
  });
}

// A notice for a session, stored at once (the chat's own path waits for a running answer: turn-notices.ts).
export async function appendNoticeToSession(sessionId: string, text: string): Promise<void> {
  const conversationId = await latestConversationIdOfSession(sessionId);
  if (!conversationId) return;
  await appendToThread(conversationId, { id: randomUUID(), role: "assistant", parts: [{ type: "text", text }] });
}

// The text of the newest customer message in a stored thread, or "" when there is none.
export function lastUserText(messages: StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    return message.parts
      .map((part) => (part as { type?: string; text?: unknown })?.type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
      .join("\n")
      .trim();
  }
  return "";
}

// Everything after the newest customer message is dropped: that is "Try again", which reruns the turn on the message that is
// already stored (the browser removes the failed reply before it asks). Undefined when there is no customer message at all.
export function trimToLastUserMessage(messages: StoredMessage[]): StoredMessage[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages.slice(0, i + 1);
  }
  return undefined;
}

// "Try again": the failed reply is removed, but what the failed turn already DID is not. A tool that finished
// (a refund approved, a case opened) stays in the history, so the model carries on from its result instead of
// starting over blind and trying to do it again. Only the reply itself goes: the reply and card tools
// (`isReplyTool`), text, tool calls that never finished, and any notice that arrived after the failed message.
// What stays is one assistant message holding those completed tool parts, right after the customer's message.
export function historyForRetry(messages: StoredMessage[], isReplyTool: (toolName: string) => boolean): StoredMessage[] | undefined {
  const upToCustomer = trimToLastUserMessage(messages);
  if (!upToCustomer) return undefined;
  const isKept = (part: any): boolean => {
    if (part?.state !== "output-available" || typeof part?.type !== "string") return false;
    if (part.type === "dynamic-tool") return typeof part.toolName === "string" && !isReplyTool(part.toolName);
    return part.type.startsWith("tool-") && !isReplyTool(part.type.slice("tool-".length));
  };
  const kept: unknown[] = [];
  let id: string | undefined;
  for (const message of messages.slice(upToCustomer.length)) {
    if (message.role !== "assistant") continue;
    let usedThisMessage = false;
    for (const part of message.parts as any[]) {
      if (part?.type === "step-start") kept.push(part);
      else if (isKept(part)) {
        kept.push(part);
        usedThisMessage = true;
      }
    }
    if (usedThisMessage) id ??= message.id;
  }
  // A step marker only means something in front of a tool call that is kept.
  const parts = kept.filter((part: any, i) => part?.type !== "step-start" || (i + 1 < kept.length && (kept[i + 1] as any)?.type !== "step-start"));
  if (!parts.some((part: any) => part?.type !== "step-start") || id === undefined) return upToCustomer;
  return [...upToCustomer, { id, role: "assistant", parts }];
}

export async function clearAllThreads(): Promise<void> {
  await (await db()).execute("DELETE FROM wismo_threads");
}
