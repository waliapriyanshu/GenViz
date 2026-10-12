import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiJsonWithRetry } from "@/lib/client/api";
import { withConnectTimeout } from "@/lib/prisma";

describe("withConnectTimeout", () => {
  it("adds a connect timeout to a URL with query parameters", () => {
    expect(
      withConnectTimeout("postgresql://u:p@host:5432/db?sslmode=require"),
    ).toBe("postgresql://u:p@host:5432/db?sslmode=require&connect_timeout=8");
  });

  it("adds a connect timeout to a URL without query parameters", () => {
    expect(withConnectTimeout("postgresql://u:p@host/db")).toBe(
      "postgresql://u:p@host/db?connect_timeout=8",
    );
  });

  it("respects a timeout that is already configured", () => {
    const url = "postgresql://u:p@host/db?connect_timeout=3&sslmode=require";
    expect(withConnectTimeout(url)).toBe(url);
  });
});

describe("apiJsonWithRetry", () => {
  afterEach(() => vi.unstubAllGlobals());

  const failure = (status: number) =>
    new Response(
      JSON.stringify({ error: { code: "internal", message: "Nope." } }),
      { status },
    );
  const success = () =>
    new Response(JSON.stringify({ sources: [] }), { status: 200 });

  it("retries a server error and returns the later success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failure(500))
      .mockResolvedValueOnce(success());
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      apiJsonWithRetry("/api/sources", { delayMs: 0 }),
    ).resolves.toEqual({ sources: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries network failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(success());
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      apiJsonWithRetry("/api/sources", { delayMs: 0 }),
    ).resolves.toEqual({ sources: [] });
  });

  it("gives up after the configured attempts", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => failure(503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      apiJsonWithRetry("/api/sources", { attempts: 3, delayMs: 0 }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => failure(404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      apiJsonWithRetry("/api/sources", { delayMs: 0 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
