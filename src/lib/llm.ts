import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY || "AIzaSyBoGJGEMQUyaS_l-NVc5a1nqKzBva55GQE";
const genAI = new GoogleGenerativeAI(apiKey);

const SYSTEM_PROMPT_TEMPLATE = (schema: string) => `
You are an expert SQL generator and Data Visualization expert.
Your goal is to parse natural language queries, generate a safe SQL query, and recommend the best visualization parameters.

DATABASE SCHEMA:
${schema}

RULES:
1. Return ONLY valid JSON (no markdown wrapping).
2. The JSON must exactly match this format:
{
  "sql": "SELECT ...",
  "chart_type": "bar" | "line" | "pie" | "area" | "scatter" | "table",
  "x_axis": "column_name",
  "y_axis": "column_name",
  "title": "A descriptive title for the chart"
}
3. ONLY use SELECT queries. NEVER return INSERT, UPDATE, DELETE, DROP, etc.
4. Use LOWER(column) for string comparisons in the WHERE clause when filtering text.
5. ALWAYS apply LIMIT 1000 to the query.
6. Make sure x_axis and y_axis refer to exact column aliases returned by your SQL query. If it's a pie chart, x_axis is the category/name field and y_axis is the value field.
`;

export async function generateSQL(question: string, schema: string) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash", // swapped from gen-3-flash-preview to limit 429 errors
    systemInstruction: SYSTEM_PROMPT_TEMPLATE(schema),
  });


  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: `Question: ${question}` }] }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const text = result.response.text();
    return JSON.parse(text);
  } catch (error: any) {
    console.error("Gemini Error:", error);
    throw new Error(`Gemini API Error: ${error.message || "Failed to generate SQL"}`);
  }
}

export function validateSQL(sql: string) {
  if (!sql) throw new Error("No SQL query generated.");
  const upperSQL = sql.trim().toUpperCase();
  if (!upperSQL.startsWith("SELECT") && !upperSQL.startsWith("WITH")) {
    throw new Error("Only SELECT queries are permitted.");
  }
  const dangerous = ["DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "TRUNCATE", "EXEC"];
  for (const keyword of dangerous) {
    // Check whole word boundary
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    if (regex.test(sql)) {
      throw new Error(`Unsafe keyword detected: ${keyword}`);
    }
  }
  return sql;
}
