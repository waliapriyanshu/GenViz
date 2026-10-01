import { config } from "@/lib/config";
import { CsvError, inferCsv, suggestQuestions } from "@/lib/data/csv-infer";
import { loadDataset, newDatasetTableName } from "@/lib/data/csv-ingest";
import { type CsvDetails, toPublicSource } from "@/lib/data/sources";
import { UserError, toUserError } from "@/lib/errors";
import { errorResponse, ndjsonResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { postgresCooldownStore } from "@/lib/security/rate-limit";
import { assertSameOrigin, getIdentity } from "@/lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_SOURCES_PER_SESSION = 25;

function decodeText(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Excel on Windows commonly exports Windows-1252.
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export async function POST(request: Request) {
  let identity: Awaited<ReturnType<typeof getIdentity>>;
  let file: File;
  try {
    await assertSameOrigin();
    identity = await getIdentity();
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > config.maxUploadBytes() + 64 * 1024) {
      throw new UserError(
        "payload_too_large",
        `The file is too large. The limit is ${Math.floor(config.maxUploadBytes() / 1024 / 1024)} MB.`,
        413,
      );
    }
    const cooldown = await postgresCooldownStore.claim(
      `upload:${identity.sessionId}`,
      5,
    );
    if (!cooldown.ok) {
      throw new UserError(
        "rate_limited",
        `Please wait ${cooldown.retryAfterSeconds}s before uploading another file.`,
        429,
        {
          retryAfterSeconds: cooldown.retryAfterSeconds,
        },
      );
    }
    const form = await request.formData();
    const entry = form.get("file");
    if (!(entry instanceof File))
      throw new UserError("bad_request", "Choose a CSV file to upload.");
    file = entry;
    if (!/\.(csv|tsv|txt)$/i.test(file.name))
      throw new UserError("invalid_csv", "Only .csv files are supported.");
    if (file.size === 0)
      throw new UserError("invalid_csv", "The file is empty.");
    if (file.size > config.maxUploadBytes()) {
      throw new UserError(
        "payload_too_large",
        `The file is too large. The limit is ${Math.floor(config.maxUploadBytes() / 1024 / 1024)} MB.`,
        413,
      );
    }
    const count = await prisma.source.count({
      where: { ownerId: identity.sessionId },
    });
    if (count >= MAX_SOURCES_PER_SESSION) {
      throw new UserError(
        "bad_request",
        "You have too many data sources. Remove one before adding another.",
      );
    }
  } catch (error) {
    return errorResponse(error);
  }

  return ndjsonResponse(
    async (send) => {
      send({ type: "stage", stage: "processing" });
      const text = decodeText(await file.arrayBuffer());
      let table;
      try {
        table = inferCsv(text, { maxRows: config.maxCsvRows() });
      } catch (error) {
        if (error instanceof CsvError)
          throw new UserError("invalid_csv", error.message);
        throw error;
      }
      send({
        type: "stage",
        stage: "analyzing",
        rows: table.rowCount,
        columns: table.columns.length,
      });
      const tableName = newDatasetTableName();
      await loadDataset(tableName, table);
      send({ type: "stage", stage: "saving" });
      const details: CsvDetails = {
        fileName: file.name.slice(0, 200),
        sizeBytes: file.size,
        rowCount: table.rowCount,
        columnCount: table.columns.length,
        columns: table.columns,
        warnings: table.warnings,
        suggestions: suggestQuestions(table.columns),
      };
      const source = await prisma.source.create({
        data: {
          ownerId: identity.sessionId,
          kind: "csv",
          name:
            file.name.replace(/\.(csv|tsv|txt)$/i, "").slice(0, 120) ||
            "Dataset",
          tableName,
          details: details as object,
        },
      });
      send({ type: "ready", source: toPublicSource(source) });
    },
    (error) => {
      const userError = toUserError(error);
      return {
        type: "error",
        code: userError.code,
        message: userError.message,
      };
    },
  );
}
