"use client";

import { ArrowUp, Hourglass, Loader2, Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCountdown } from "@/hooks/use-countdown";
import { formatDuration } from "@/lib/client/format";

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

export function Composer({
  onSend,
  busy,
  cooldownUntil,
  disabledReason,
  value,
  onChange,
}: {
  onSend: (text: string) => void;
  busy: boolean;
  cooldownUntil: number | null;
  disabledReason?: string;
  value: string;
  onChange: (text: string) => void;
}) {
  const remaining = useCountdown(cooldownUntil);
  const coolingDown = remaining > 0;
  const blocked = busy || coolingDown || !!disabledReason;
  const canSend = !blocked && value.trim().length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);

  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ");
      onChange(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setSpeechSupported(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
  };

  const toggleMic = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (listening) {
      recognition.stop();
      setListening(false);
    } else {
      recognition.start();
      setListening(true);
    }
  };

  const status = busy
    ? "Analyzing your data…"
    : coolingDown
      ? `Next query available in ${formatDuration(remaining)}`
      : (disabledReason ?? "");

  return (
    <div className="space-y-2">
      <div
        className={`flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-sm transition focus-within:ring-2 focus-within:ring-primary/40 ${blocked ? "opacity-90" : ""}`}
      >
        <label htmlFor="genviz-question" className="sr-only">
          Ask a question about your data
        </label>
        <textarea
          id="genviz-question"
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabledReason ?? "Ask anything about your data…"}
          disabled={!!disabledReason}
          maxLength={1000}
          className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        {speechSupported && (
          <button
            type="button"
            onClick={toggleMic}
            disabled={!!disabledReason}
            className={`flex h-10 w-10 items-center justify-center rounded-xl transition ${listening ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:bg-accent"} disabled:opacity-50`}
            aria-label={listening ? "Stop voice input" : "Ask with your voice"}
            title={listening ? "Stop voice input" : "Ask with your voice"}
          >
            {listening ? (
              <MicOff className="h-5 w-5" />
            ) : (
              <Mic className="h-5 w-5" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
          aria-label="Send question"
        >
          {busy ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : coolingDown ? (
            <Hourglass className="h-5 w-5" />
          ) : (
            <ArrowUp className="h-5 w-5" />
          )}
        </button>
      </div>
      <div
        className="flex min-h-[20px] items-center justify-between px-1 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <span
          className={
            coolingDown
              ? "font-medium tabular-nums text-amber-600 dark:text-amber-400"
              : ""
          }
        >
          {status}
        </span>
        <span className="hidden sm:inline">
          Genviz only reads your data — it never changes it.
        </span>
      </div>
    </div>
  );
}
