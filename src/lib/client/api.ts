"use client";

export interface ApiErrorBody {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

async function readError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody = { code: "internal", message: FALLBACK_MESSAGE };
  try {
    const json = (await response.json()) as { error?: ApiErrorBody };
    if (json?.error?.message) body = json.error;
  } catch {
    if (response.status === 413)
      body = {
        code: "payload_too_large",
        message: "The file is too large to upload.",
      };
  }
  if (response.status === 429 && body.retryAfterSeconds === undefined) {
    const header = Number(response.headers.get("Retry-After"));
    if (Number.isFinite(header) && header > 0) body.retryAfterSeconds = header;
  }
  return new ApiError(response.status, body);
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, {
      code: "network",
      message: "Couldn't reach Genviz. Check your connection and try again.",
    });
  }
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

/** POSTs JSON and yields newline-delimited JSON events as they stream in. */
export async function* streamNdjson<T>(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new ApiError(0, {
      code: "network",
      message: "Couldn't reach Genviz. Check your connection and try again.",
    });
  }
  if (!response.ok) throw await readError(response);
  if (!response.body)
    throw new ApiError(500, { code: "internal", message: FALLBACK_MESSAGE });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as T;
      newline = buffer.indexOf("\n");
    }
  }
  const rest = buffer.trim();
  if (rest) yield JSON.parse(rest) as T;
}

/**
 * Multipart upload with real upload progress (XHR) plus streamed server stages.
 */
export function uploadWithProgress<TEvent>(
  url: string,
  form: FormData,
  handlers: {
    onUploadProgress: (fraction: number) => void;
    onEvent: (event: TEvent) => void;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let consumed = 0;
    const flush = (final: boolean) => {
      const text = xhr.responseText;
      let newline = text.indexOf("\n", consumed);
      while (newline >= 0) {
        const line = text.slice(consumed, newline).trim();
        consumed = newline + 1;
        if (line) handlers.onEvent(JSON.parse(line) as TEvent);
        newline = text.indexOf("\n", consumed);
      }
      if (final) {
        const rest = text.slice(consumed).trim();
        if (rest) handlers.onEvent(JSON.parse(rest) as TEvent);
      }
    };
    xhr.open("POST", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        handlers.onUploadProgress(event.loaded / event.total);
    };
    xhr.onprogress = () => {
      if (xhr.status >= 200 && xhr.status < 300) flush(false);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          flush(true);
          resolve();
        } catch {
          reject(
            new ApiError(500, { code: "internal", message: FALLBACK_MESSAGE }),
          );
        }
        return;
      }
      let body: ApiErrorBody = {
        code: "internal",
        message:
          xhr.status === 413
            ? "The file is too large to upload."
            : FALLBACK_MESSAGE,
      };
      try {
        const json = JSON.parse(xhr.responseText) as { error?: ApiErrorBody };
        if (json.error?.message) body = json.error;
      } catch {
        // keep fallback
      }
      reject(new ApiError(xhr.status, body));
    };
    xhr.onerror = () =>
      reject(
        new ApiError(0, {
          code: "network",
          message: "The upload failed. Check your connection and try again.",
        }),
      );
    xhr.send(form);
  });
}
