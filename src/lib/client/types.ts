import type { AssistantPayload } from "@/lib/viz/types";

export type ColumnKindLabel =
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "timestamp"
  | "text";

export type ClientSource =
  | {
      id: string;
      kind: "csv";
      name: string;
      createdAt: string;
      fileName: string;
      rowCount: number;
      columnCount: number;
      columns: Array<{
        name: string;
        label: string;
        kind: ColumnKindLabel;
        role: string;
      }>;
      warnings: string[];
      suggestions: string[];
    }
  | {
      id: string;
      kind: "postgres";
      name: string;
      createdAt: string;
      database: string;
      host: string;
      tableCount: number;
      tables: string[];
      warnings: string[];
      suggestions: string[];
    };

export type ChatMessage =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; payload: AssistantPayload }
  | {
      id: string;
      role: "notice";
      tone: "rate_limit" | "error";
      message: string;
      until?: number;
    };
