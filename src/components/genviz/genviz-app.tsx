"use client";

import {
  ChevronDown,
  Database,
  FileSpreadsheet,
  Loader2,
  MessageSquarePlus,
  Sparkles,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AssistantMessage } from "@/components/genviz/assistant-message";
import { Composer } from "@/components/genviz/composer";
import { NoticeMessage } from "@/components/genviz/notice-message";
import { ProgressSteps } from "@/components/genviz/progress-steps";
import { SourceCard, sourceLabel } from "@/components/genviz/source-card";
import { SourcePanel, uploadCsvFile } from "@/components/genviz/source-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  ApiError,
  apiJson,
  apiJsonWithRetry,
  streamNdjson,
} from "@/lib/client/api";
import type { ChatMessage, ClientSource } from "@/lib/client/types";
import type {
  AssistantPayload,
  ChatStreamEvent,
  ProgressStage,
} from "@/lib/viz/types";

const ACTIVE_KEY = "genviz.activeSource";
const conversationKey = (sourceId: string) => `genviz.conversation.${sourceId}`;

// Only non-sensitive ids are kept in localStorage (never credentials).
const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      // storage unavailable (private mode), which is fine
    }
  },
};

let idCounter = 0;
const localId = () => `local-${Date.now()}-${++idCounter}`;

interface StoredMessage {
  id: string;
  role: string;
  content: string;
  payload: AssistantPayload | null;
}

export default function GenvizApp() {
  const [sources, setSources] = useState<ClientSource[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<ProgressStage[] | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [panel, setPanel] = useState<{
    open: boolean;
    tab: "csv" | "postgres";
  }>({ open: false, tab: "csv" });
  const [sampleState, setSampleState] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = sources.find((s) => s.id === activeId) ?? null;

  const startCooldown = (seconds: number | undefined) => {
    if (seconds && seconds > 0) setCooldownUntil(Date.now() + seconds * 1000);
  };

  // Initial load: sources + any active cooldown (survives reloads).
  useEffect(() => {
    (async () => {
      try {
        const [{ sources: list }, limit] = await Promise.all([
          apiJsonWithRetry<{ sources: ClientSource[] }>("/api/sources"),
          apiJson<{ retryAfterSeconds: number }>("/api/rate-limit").catch(
            () => ({ retryAfterSeconds: 0 }),
          ),
        ]);
        setSources(list);
        const remembered = storage.get(ACTIVE_KEY);
        setActiveId(
          list.find((s) => s.id === remembered)?.id ?? list[0]?.id ?? null,
        );
        startCooldown(limit.retryAfterSeconds);
      } catch (error) {
        setBootError(
          error instanceof ApiError
            ? error.body.message
            : "Couldn't load Genviz. Please refresh the page.",
        );
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // Restore the conversation for the active source.
  useEffect(() => {
    abortRef.current?.abort();
    setMessages([]);
    setConversationId(null);
    if (!activeId) return;
    storage.set(ACTIVE_KEY, activeId);
    const saved = storage.get(conversationKey(activeId));
    if (!saved) return;
    let cancelled = false;
    apiJson<{ messages: StoredMessage[] }>(`/api/conversations/${saved}`)
      .then(({ messages: stored }) => {
        if (cancelled) return;
        setConversationId(saved);
        setMessages(
          stored.map<ChatMessage>((m) =>
            m.role === "user"
              ? { id: m.id, role: "user", content: m.content }
              : {
                  id: m.id,
                  role: "assistant",
                  payload: m.payload ?? {
                    status: "answered",
                    answer: m.content,
                  },
                },
          ),
        );
      })
      .catch(() => storage.set(conversationKey(activeId), null));
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, pending]);

  const addSource = (source: ClientSource) => {
    setSources((list) => [source, ...list.filter((s) => s.id !== source.id)]);
    setActiveId(source.id);
    setPanel((p) => ({ ...p, open: false }));
  };

  const removeSource = async (source: ClientSource) => {
    try {
      await apiJson(`/api/sources/${source.id}`, { method: "DELETE" });
      storage.set(conversationKey(source.id), null);
      setSources((list) => {
        const next = list.filter((s) => s.id !== source.id);
        if (activeId === source.id) setActiveId(next[0]?.id ?? null);
        return next;
      });
    } catch (error) {
      window.alert(
        error instanceof ApiError
          ? error.body.message
          : "Couldn't remove the source.",
      );
    }
  };

  const newChat = () => {
    if (!activeId) return;
    storage.set(conversationKey(activeId), null);
    setConversationId(null);
    setMessages([]);
  };

  const loadSample = async () => {
    setSampleState("Downloading sample…");
    try {
      const response = await fetch("/samples/sales-sample.csv");
      const blob = await response.blob();
      const file = new File([blob], "sales-sample.csv", { type: "text/csv" });
      const source = await uploadCsvFile(file, (state) => {
        const labels: Record<string, string> = {
          uploading: "Uploading…",
          processing: "Processing dataset…",
          analyzing: "Analyzing columns…",
          saving: "Getting it ready…",
        };
        if (state.phase in labels) setSampleState(labels[state.phase]!);
      });
      addSource(source);
      setSampleState(null);
    } catch (error) {
      setSampleState(null);
      window.alert(
        error instanceof Error
          ? error.message
          : "Couldn't load the sample dataset.",
      );
    }
  };

  const ask = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || pending) return;
      if (!active) {
        setPanel({ open: true, tab: "csv" });
        return;
      }
      setInput("");
      setMessages((list) => [
        ...list,
        { id: localId(), role: "user", content: question },
      ]);
      setPending([]);
      const controller = new AbortController();
      abortRef.current = controller;
      let finished = false;
      try {
        const events = streamNdjson<ChatStreamEvent>(
          "/api/chat",
          {
            message: question,
            sourceId: active.id,
            conversationId: conversationId ?? undefined,
          },
          controller.signal,
        );
        for await (const event of events) {
          if (event.type === "conversation") {
            setConversationId(event.conversationId);
            storage.set(conversationKey(active.id), event.conversationId);
          } else if (event.type === "stage") {
            setPending((stages) => [...(stages ?? []), event.stage]);
          } else if (event.type === "result") {
            finished = true;
            setMessages((list) => [
              ...list,
              {
                id: event.messageId,
                role: "assistant",
                payload: event.payload,
              },
            ]);
            startCooldown(event.nextQueryInSeconds);
          } else if (event.type === "rate_limited") {
            finished = true;
            const until = Date.now() + event.retryAfterSeconds * 1000;
            setCooldownUntil(until);
            setMessages((list) => [
              ...list,
              {
                id: localId(),
                role: "notice",
                tone: "rate_limit",
                message: event.message,
                until,
              },
            ]);
          } else if (event.type === "error") {
            finished = true;
            startCooldown(event.nextQueryInSeconds);
            setMessages((list) => [
              ...list,
              {
                id: localId(),
                role: "notice",
                tone: "error",
                message: event.message,
              },
            ]);
          }
        }
        if (!finished && !controller.signal.aborted) {
          setMessages((list) => [
            ...list,
            {
              id: localId(),
              role: "notice",
              tone: "error",
              message: "The response was interrupted. Please try again.",
            },
          ]);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.body.code === "rate_limited") {
          const seconds = error.body.retryAfterSeconds ?? 30;
          const until = Date.now() + seconds * 1000;
          setCooldownUntil(until);
          setMessages((list) => [
            ...list,
            {
              id: localId(),
              role: "notice",
              tone: "rate_limit",
              message: error.body.message,
              until,
            },
          ]);
        } else {
          const message =
            error instanceof ApiError
              ? error.body.message
              : "Something went wrong. Please try again.";
          setMessages((list) => [
            ...list,
            { id: localId(), role: "notice", tone: "error", message },
          ]);
          if (
            error instanceof ApiError &&
            error.status === 404 &&
            error.body.code === "not_found"
          ) {
            // the source vanished server-side; refresh the list
            apiJson<{ sources: ClientSource[] }>("/api/sources")
              .then(({ sources: list }) => setSources(list))
              .catch(() => undefined);
          }
        }
      } finally {
        setPending(null);
        abortRef.current = null;
      }
    },
    [active, conversationId, pending],
  );

  const busy = pending !== null;

  return (
    <div className="flex h-[100dvh] flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles className="h-4 w-4" />
            </span>
            <span className="hidden sm:inline">Genviz</span>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setPanel({ open: true, tab: active?.kind ?? "csv" })
              }
              className="flex max-w-[60vw] items-center gap-2 rounded-full border px-3 py-1.5 text-sm hover:bg-accent sm:max-w-sm"
              aria-label="Change data source"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${active ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                aria-hidden
              />
              <span className="hidden text-muted-foreground sm:inline">
                Data source
              </span>
              <span className="truncate font-medium">
                {active ? sourceLabel(active) : "Connect data"}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={newChat}
                disabled={busy}
                className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
                title="Start a new conversation"
              >
                <MessageSquarePlus className="h-4 w-4" />{" "}
                <span className="hidden sm:inline">New chat</span>
              </button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
          {booting ? (
            <div className="flex justify-center py-24 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
            </div>
          ) : bootError ? (
            <NoticeMessage tone="error" message={bootError} />
          ) : !active ? (
            <section className="py-10 text-center">
              <h1 className="text-4xl font-semibold tracking-tight">
                Talk to your data.
              </h1>
              <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
                Upload a CSV or connect a PostgreSQL database, then ask
                questions in plain English. Genviz queries your data safely and
                answers with charts.
              </p>
              <div className="mt-10 grid gap-3 text-left sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setPanel({ open: true, tab: "csv" })}
                  className="rounded-2xl border bg-card p-5 transition hover:border-primary/50 hover:shadow-sm"
                >
                  <Upload className="h-6 w-6 text-primary" />
                  <div className="mt-3 font-medium">Upload a CSV</div>
                  <div className="mt-1 text-balance text-sm text-muted-foreground">
                    Get instant charts from a spreadsheet export.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setPanel({ open: true, tab: "postgres" })}
                  className="rounded-2xl border bg-card p-5 transition hover:border-primary/50 hover:shadow-sm"
                >
                  <Database className="h-6 w-6 text-primary" />
                  <div className="mt-3 font-medium">Connect PostgreSQL</div>
                  <div className="mt-1 text-balance text-sm text-muted-foreground">
                    Ask questions of a live database, read-only.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={loadSample}
                  disabled={!!sampleState}
                  className="rounded-2xl border bg-card p-5 transition hover:border-primary/50 hover:shadow-sm disabled:opacity-70"
                >
                  {sampleState ? (
                    <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  ) : (
                    <FileSpreadsheet className="h-6 w-6 text-primary" />
                  )}
                  <div className="mt-3 font-medium">Try a sample dataset</div>
                  <div className="mt-1 text-balance text-sm text-muted-foreground">
                    {sampleState ?? "1,688 sales orders from 2025 to 2026."}
                  </div>
                </button>
              </div>
            </section>
          ) : (
            <>
              {messages.length === 0 && (
                <SourceCard source={active} onAsk={ask} disabled={busy} />
              )}
              {messages.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground">
                      {message.content}
                    </div>
                  </div>
                ) : message.role === "assistant" ? (
                  <AssistantMessage
                    key={message.id}
                    payload={message.payload}
                    onAsk={ask}
                    disabled={busy}
                  />
                ) : (
                  <NoticeMessage
                    key={message.id}
                    tone={message.tone}
                    message={message.message}
                    until={message.until}
                  />
                ),
              )}
              {pending && (
                <div className="flex gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Sparkles className="h-4 w-4 animate-pulse" aria-hidden />
                  </div>
                  <ProgressSteps
                    stages={pending.length ? pending : ["understanding"]}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <footer className="border-t bg-background/95">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <Composer
            value={input}
            onChange={setInput}
            onSend={ask}
            busy={busy}
            cooldownUntil={cooldownUntil}
            disabledReason={
              !active && !booting ? "Connect data to start" : undefined
            }
          />
        </div>
      </footer>

      <SourcePanel
        open={panel.open}
        initialTab={panel.tab}
        sources={sources}
        activeSourceId={activeId}
        onClose={() => setPanel((p) => ({ ...p, open: false }))}
        onSelect={(source) => {
          setActiveId(source.id);
          setPanel((p) => ({ ...p, open: false }));
        }}
        onAdded={addSource}
        onRemove={removeSource}
      />
    </div>
  );
}
