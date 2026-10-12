"use client";

import {
  ArrowRight,
  ChevronDown,
  Loader2,
  MessageSquarePlus,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AssistantMessage } from "@/components/genviz/assistant-message";
import { Composer } from "@/components/genviz/composer";
import { LogoMark } from "@/components/genviz/logo";
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
          <div className="flex items-center gap-2">
            <LogoMark className="h-6 w-6 shrink-0 text-primary" />
            <span className="hidden text-xl font-semibold tracking-tight sm:inline">
              Genviz
            </span>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setPanel({ open: true, tab: active?.kind ?? "csv" })
              }
              className="flex max-w-[60vw] items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent sm:max-w-sm"
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
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-8">
          {booting ? (
            <div className="flex justify-center py-24 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
            </div>
          ) : bootError ? (
            <NoticeMessage tone="error" message={bootError} />
          ) : !active ? (
            <section className="pb-2 pt-6 sm:pt-14">
              <h1 className="text-balance text-4xl font-medium leading-[1.3] tracking-tight sm:text-5xl">
                Ask your data a{" "}
                <mark className="rounded-[2px] bg-highlight box-decoration-clone px-1 text-highlight-foreground">
                  question
                </mark>
                .
              </h1>
              <p className="mt-4 max-w-xl text-pretty text-[17px] leading-relaxed text-muted-foreground">
                Upload a CSV or connect a PostgreSQL database, then ask in plain
                English. Genviz answers with a chart and the numbers behind it.
              </p>
              <ul className="mt-10 divide-y border-y">
                {[
                  {
                    title: "Upload a CSV",
                    text: "Drop in a spreadsheet export.",
                    onClick: () => setPanel({ open: true, tab: "csv" }),
                  },
                  {
                    title: "Connect PostgreSQL",
                    text: "Query a live database through a read-only connection.",
                    onClick: () => setPanel({ open: true, tab: "postgres" }),
                  },
                  {
                    title: "Try the sample data",
                    text:
                      sampleState ?? "1,688 sales orders from 2025 to 2026.",
                    onClick: loadSample,
                    loading: !!sampleState,
                  },
                ].map((option, index) => (
                  <li key={option.title}>
                    <button
                      type="button"
                      onClick={option.onClick}
                      disabled={option.loading}
                      className="group flex w-full items-center gap-4 px-1 py-4 text-left transition-colors hover:bg-accent/60 disabled:opacity-70 sm:gap-6"
                    >
                      <span className="w-6 font-mono text-xs text-muted-foreground">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">
                          {option.title}
                        </span>
                        <span className="mt-0.5 block text-sm text-muted-foreground">
                          {option.text}
                        </span>
                      </span>
                      {option.loading ? (
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      ) : (
                        <ArrowRight className="h-4 w-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <>
              {messages.length === 0 && (
                <SourceCard source={active} onAsk={ask} disabled={busy} />
              )}
              {messages.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-line rounded-lg border bg-secondary px-4 py-2.5">
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
                <ProgressSteps
                  stages={pending.length ? pending : ["understanding"]}
                />
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
