"use client";

import {
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Loader2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiJson, uploadWithProgress } from "@/lib/client/api";
import type { ClientSource } from "@/lib/client/types";

type Tab = "csv" | "postgres";

type UploadEvent =
  | {
      type: "stage";
      stage: "processing" | "analyzing" | "saving";
      rows?: number;
      columns?: number;
    }
  | { type: "ready"; source: ClientSource }
  | { type: "error"; code: string; message: string };

type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; fraction: number; fileName: string }
  | {
      phase: "processing" | "analyzing" | "saving";
      fileName: string;
      rows?: number;
      columns?: number;
    }
  | { phase: "error"; message: string };

const UPLOAD_STEPS: Array<{
  key: "uploading" | "processing" | "analyzing" | "saving";
  label: string;
}> = [
  { key: "uploading", label: "Uploading" },
  { key: "processing", label: "Processing dataset" },
  { key: "analyzing", label: "Analyzing columns" },
  { key: "saving", label: "Getting it ready" },
];

export async function uploadCsvFile(
  file: File,
  onState: (state: UploadState) => void,
): Promise<ClientSource> {
  const form = new FormData();
  form.append("file", file);
  let ready: ClientSource | null = null;
  let failure: string | null = null;
  onState({ phase: "uploading", fraction: 0, fileName: file.name });
  try {
    await uploadWithProgress<UploadEvent>("/api/sources/csv", form, {
      onUploadProgress: (fraction) =>
        onState({ phase: "uploading", fraction, fileName: file.name }),
      onEvent: (event) => {
        if (event.type === "stage")
          onState({
            phase: event.stage,
            fileName: file.name,
            rows: event.rows,
            columns: event.columns,
          });
        else if (event.type === "ready") ready = event.source;
        else failure = event.message;
      },
    });
  } catch (error) {
    failure =
      error instanceof ApiError
        ? error.body.message
        : "The upload failed. Please try again.";
  }
  if (failure || !ready) {
    const message = failure ?? "The upload didn't finish. Please try again.";
    onState({ phase: "error", message });
    throw new Error(message);
  }
  onState({ phase: "idle" });
  return ready;
}

function UploadTab({ onReady }: { onReady: (source: ClientSource) => void }) {
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = state.phase !== "idle" && state.phase !== "error";

  const handleFile = async (file: File | undefined) => {
    if (!file || busy) return;
    try {
      onReady(await uploadCsvFile(file, setState));
    } catch {
      // state already shows the error
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const currentIndex = busy
    ? UPLOAD_STEPS.findIndex((s) => s.key === state.phase)
    : -1;

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFile(e.dataTransfer.files?.[0]);
        }}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition ${dragging ? "border-primary bg-primary/5" : "border-border"}`}
      >
        <Upload className="h-8 w-8 text-muted-foreground" aria-hidden />
        <div className="font-medium">Drop a CSV file here</div>
        <div className="text-sm text-muted-foreground">or</div>
        <Button
          type="button"
          variant="outline"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          Choose file
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => void handleFile(e.target.files?.[0])}
          aria-label="Choose a CSV file"
        />
        <div className="text-xs text-muted-foreground">
          Up to 4 MB. Your data stays private to this browser session.
        </div>
      </div>

      {busy && (
        <div className="space-y-2 rounded-xl border p-4" aria-live="polite">
          <div className="truncate text-sm font-medium">
            {"fileName" in state ? state.fileName : ""}
          </div>
          {UPLOAD_STEPS.map((step, i) => {
            const done = i < currentIndex;
            const active = i === currentIndex;
            return (
              <div
                key={step.key}
                className={`flex items-center gap-2 text-sm ${active ? "" : done ? "text-muted-foreground" : "text-muted-foreground/50"}`}
              >
                {done ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : active ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : (
                  <span className="h-4 w-4 rounded-full border" />
                )}
                <span>
                  {step.label}
                  {active && state.phase === "uploading"
                    ? ` ${Math.round(state.fraction * 100)}%`
                    : ""}
                  {step.key === "analyzing" &&
                  (done || active) &&
                  "rows" in state &&
                  state.rows
                    ? ` — ${state.rows.toLocaleString()} rows, ${state.columns} columns`
                    : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {state.phase === "error" && (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {state.message}
        </div>
      )}
    </div>
  );
}

interface TestResult {
  database: string;
  host: string;
  tableCount: number;
  tables: string[];
  warnings: string[];
}

function ConnectTab({ onReady }: { onReady: (source: ClientSource) => void }) {
  const [connectionString, setConnectionString] = useState("");
  const [name, setName] = useState("");
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const test = async () => {
    setTesting(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await apiJson<TestResult>("/api/sources/postgres/test", {
          method: "POST",
          body: JSON.stringify({ connectionString }),
        }),
      );
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.body.message
          : "Couldn't test the connection.",
      );
    } finally {
      setTesting(false);
    }
  };

  const connect = async () => {
    setSaving(true);
    setError(null);
    try {
      const { source } = await apiJson<{ source: ClientSource }>(
        "/api/sources/postgres",
        {
          method: "POST",
          body: JSON.stringify({ connectionString, name: name || undefined }),
        },
      );
      setConnectionString(""); // never keep credentials in the browser longer than needed
      setResult(null);
      onReady(source);
    } catch (e) {
      setError(e instanceof ApiError ? e.body.message : "Couldn't connect.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="pg-connection" className="text-sm font-medium">
          PostgreSQL connection string
        </label>
        <div className="flex items-center gap-2 rounded-lg border bg-background pr-1 focus-within:ring-2 focus-within:ring-primary/40">
          <input
            id="pg-connection"
            type={reveal ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            value={connectionString}
            onChange={(e) => {
              setConnectionString(e.target.value);
              setResult(null);
            }}
            placeholder="postgresql://user:password@host:5432/database?sslmode=require"
            className="h-10 flex-1 bg-transparent px-3 font-mono text-sm outline-none"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            aria-label={
              reveal ? "Hide connection string" : "Show connection string"
            }
          >
            {reveal ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Use a <strong>read-only</strong> database user. The connection string
          is encrypted on the server and never stored in your browser. Genviz
          only runs read-only queries with a timeout.
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="pg-name" className="text-sm font-medium">
          Display name{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <input
          id="pg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="e.g. Sales DB"
          className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={test}
          disabled={testing || saving || connectionString.trim().length < 10}
        >
          {testing && <Loader2 className="animate-spin" />} Test connection
        </Button>
        <Button type="button" onClick={connect} disabled={!result || saving}>
          {saving && <Loader2 className="animate-spin" />} Use this database
        </Button>
      </div>
      {result && (
        <div
          className="space-y-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" /> Connected to {result.database}
          </div>
          <div className="text-muted-foreground">
            {result.tableCount} table{result.tableCount === 1 ? "" : "s"}{" "}
            detected on {result.host}
          </div>
          {result.tables.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {result.tables.slice(0, 12).map((t) => (
                <span
                  key={t}
                  className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
          {result.warnings.map((w) => (
            <div key={w} className="text-xs text-amber-700 dark:text-amber-400">
              {w}
            </div>
          ))}
        </div>
      )}
      {error && (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function SourcePanel({
  open,
  initialTab,
  sources,
  activeSourceId,
  onClose,
  onSelect,
  onAdded,
  onRemove,
}: {
  open: boolean;
  initialTab: Tab;
  sources: ClientSource[];
  activeSourceId: string | null;
  onClose: () => void;
  onSelect: (source: ClientSource) => void;
  onAdded: (source: ClientSource) => void;
  onRemove: (source: ClientSource) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-panel-title"
        className="flex h-full w-full max-w-lg flex-col overflow-y-auto bg-background shadow-2xl animate-in slide-in-from-right"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 id="source-panel-title" className="text-lg font-semibold">
            Data sources
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6 p-5">
          {sources.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Your sources
              </h3>
              <ul className="space-y-2">
                {sources.map((source) => {
                  const active = source.id === activeSourceId;
                  return (
                    <li
                      key={source.id}
                      className={`flex items-center gap-3 rounded-xl border p-3 ${active ? "border-primary/50 bg-primary/5" : ""}`}
                    >
                      {source.kind === "csv" ? (
                        <FileSpreadsheet className="h-5 w-5 shrink-0 text-muted-foreground" />
                      ) : (
                        <Database className="h-5 w-5 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {source.kind === "csv"
                            ? source.fileName
                            : source.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {source.kind === "csv"
                            ? `CSV · ${source.rowCount.toLocaleString()} rows · ${source.columnCount} columns`
                            : `PostgreSQL · ${source.database} · ${source.tableCount} tables`}
                        </div>
                      </div>
                      {active ? (
                        <span className="text-xs font-medium text-primary">
                          Active
                        </span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => onSelect(source)}
                        >
                          Use
                        </Button>
                      )}
                      <button
                        type="button"
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                        aria-label={`Remove ${source.name}`}
                        disabled={removing === source.id}
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Remove "${source.name}" from Genviz? ${source.kind === "csv" ? "The uploaded data will be deleted." : "Your database is not affected."}`,
                            )
                          )
                            return;
                          setRemoving(source.id);
                          try {
                            await onRemove(source);
                          } finally {
                            setRemoving(null);
                          }
                        }}
                      >
                        {removing === source.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="space-y-4">
            <div
              className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
              role="tablist"
            >
              {(
                [
                  ["csv", "Upload CSV", FileSpreadsheet],
                  ["postgres", "Connect PostgreSQL", Database],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${tab === key ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>
            {tab === "csv" ? (
              <UploadTab onReady={onAdded} />
            ) : (
              <ConnectTab onReady={onAdded} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
