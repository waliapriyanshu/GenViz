import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { generateSQL, validateSQL } from "@/lib/llm";
import { mapToChart } from "@/lib/visualization-mapper";
import { getPostgresSchema, executePostgresQuery } from "@/lib/db-connector";

const prisma = new PrismaClient();

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { question, customDatabaseUrl } = body;

    if (!question) {
      return NextResponse.json({ error: "No question provided" }, { status: 400 });
    }

    // Dynamically retrieve schema to allow Gemini to query uploaded datasets or remote DBs
    let activeSchemaContext = "";
    try {
      if (customDatabaseUrl) {
        activeSchemaContext = await getPostgresSchema(customDatabaseUrl);
      } else {
        const tables: any = await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'");
        let schemaBlock = "";
        for (const t of tables) {
          const columns: any = await prisma.$queryRawUnsafe(`PRAGMA table_info(${t.name})`);
          schemaBlock += `Table Name: ${t.name}\nColumns:\n`;
          for (const col of columns) {
            schemaBlock += `- ${col.name} (${col.type})\n`;
          }
          schemaBlock += "\n";
        }
        activeSchemaContext = schemaBlock || "Table Name: Data\nAny normal columns expected in a generic dataset.";
      }
    } catch(schemaErr: any) {
      console.warn("Could not dynamically resolve schema", schemaErr);
      return NextResponse.json({ error: "Failed to read database schema", details: schemaErr.message }, { status: 400 });
    }

    // 1. NL to SQL via Gemini
    const llmResult = await generateSQL(question, activeSchemaContext);
    if (!llmResult || !llmResult.sql) {
      return NextResponse.json({ error: "Failed to generate SQL" }, { status: 500 });
    }

    // 2. Validate SQL safety
    let safeSql;
    try {
      safeSql = validateSQL(llmResult.sql);
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    // 3. Execute via DB Pool or local Prisma
    let data;
    try {
      if (customDatabaseUrl) {
         data = await executePostgresQuery(customDatabaseUrl, safeSql);
      } else {
         data = await prisma.$queryRawUnsafe(safeSql);
      }
      
      // Convert any Prisma/PG BigInt primitives to standard Numbers to avoid JSON.stringify crash (BigInt serialization error)
      if (Array.isArray(data)) {
        data = data.map((row: any) => {
          const newRow: any = {};
          for (const key in row) {
            newRow[key] = typeof row[key] === "bigint" ? Number(row[key]) : row[key];
          }
          return newRow;
        });
      }
    } catch (dbErr: any) {
      console.error(dbErr);
      return NextResponse.json({ error: "Database execution failed. The SQL query syntax might not perfectly match your data types.", details: dbErr.message }, { status: 400 });
    }

    // 4. Map to Visualization
    const chartResponse = mapToChart(data as any[], llmResult);

    return NextResponse.json({
      sql: safeSql,
      chart: chartResponse,
      llmSchema: llmResult
    });
  } catch (err: any) {
    console.error("API Error: ", err);
    return NextResponse.json({ error: err.message || "Internal Server Error", details: err.message }, { status: 500 });
  }
}
