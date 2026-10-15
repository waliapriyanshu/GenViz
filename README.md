# Genviz

**Ask questions about a CSV file or a PostgreSQL database in plain English and receive a grounded answer, a chart, and the data behind it.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-supported-336791)](https://www.postgresql.org)

**Live demo:** [genvizai.vercel.app](https://genvizai.vercel.app)

## Table of contents

- [Overview](#overview)
- [Key features](#key-features)
- [Use cases](#use-cases)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Usage](#usage)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security](#security)
- [Limitations](#limitations)
- [Project structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

## Overview

Valuable data often sits in spreadsheets and databases that only a few people know how to query. Answering a simple question such as "Which region had the highest revenue last quarter?" usually means waiting for an analyst or writing SQL by hand.

Genviz removes that barrier. A user uploads a CSV file or connects a PostgreSQL database and asks questions in natural language. Genviz translates each question into a single read-only SQL query, executes it under strict safeguards, and returns a short written answer together with an appropriate chart and the underlying table.

The project is built around four principles:

- **Read-only.** Genviz can never modify the data it analyzes.
- **Grounded.** Every number in an answer originates from a real query result, never from the language model's own arithmetic.
- **Transparent.** Each answer can show the exact SQL, the steps taken, the row count, and the execution time.
- **Economical.** It runs on open-weight models through Groq's free tier by default, and the provider is configurable.

## Key features

- **Natural-language analysis.** Ask questions in plain English and receive a concise answer with a visualization and a data table.
- **Two data sources.** Upload a CSV file (up to 4 MB by default) or connect a live PostgreSQL database through a read-only connection.
- **Conversational follow-ups.** Requests such as "only for 2026", "compare that with last year", or "show it as a pie chart" build on the previous analysis.
- **Grounded answers.** The model does not perform arithmetic. Trends, shares, rankings, period comparisons, distributions, and anomalies are computed deterministically. Any answer that mentions a number absent from the results is replaced with a computed summary.
- **Automatic visualization.** Line, area, bar, pie, scatter, histogram, KPI, and table views are chosen from the shape of the result.
- **Defense in depth for SQL.** Model-written SQL is parsed with the real PostgreSQL parser and must be a single `SELECT` over permitted tables. It then runs in a `READ ONLY` transaction with a statement timeout and a row cap.
- **Accurate CSV handling.** Column types are inferred from every row, including dates, currency, percentages, booleans, and leading-zero codes. A file is loaded completely or not at all.
- **Privacy and isolation.** Data, conversations, and queries are scoped to an anonymous, signed session. Stored connection strings are encrypted with AES-256-GCM and are never sent to the browser.
- **Live progress.** The interface streams each stage of the analysis as it happens.
- **Responsive and accessible interface.** Light and dark themes, a layout that works from small phones to desktops, and optional voice input where the browser supports speech recognition.
- **Provider-agnostic model layer.** The default model is `openai/gpt-oss-120b` on Groq. The model and an ordered list of fallback models are set through environment variables.

## Use cases

| Scenario | Example questions |
| --- | --- |
| **Self-service business analytics.** Give non-technical teams direct answers from sales, finance, or operations data. | "Show revenue by month." "Which region has the highest revenue?" |
| **Rapid exploration of exports.** Inspect a spreadsheet exported from a CRM, billing system, or survey tool without building a dashboard. | "Compare revenue across channels." "Give me a summary of this data." |
| **Read-only access to operational databases.** Let stakeholders query a production replica or reporting database without write risk. | "How many orders were placed last week by product category?" |
| **Analyst acceleration.** Draft an analysis quickly, then review the generated SQL and refine it. | "Why did revenue change from 2025 to 2026?" |
| **Data quality triage.** Spot outliers and unusual distributions early. | "Show the distribution of revenue." "Are there anomalies in unit price?" |
| **Demonstrations and teaching.** Show how natural-language analytics works using the bundled sample dataset of 1,688 sales orders. | "Which channel contributes the largest share of revenue?" |

## Architecture

### Request flow

```
Browser (chat interface)
        |
        |  POST /api/chat  (newline-delimited JSON stream)
        v
Rate limiting: session, client IP, and model provider
        |
        v
Load conversation history and the active data source
        |
        v
Orchestrator (Vercel AI SDK, bounded tool loop)
   tools: get_schema, profile_column, run_query,
          analyze_data, make_visualization, final_answer
        |
        | run_query
        v
Query Guard (libpg-query AST) -> Executor (READ ONLY transaction,
   statement timeout, row cap, SELECT-only role for uploaded data)
        |
        v
Deterministic analysis (trend, top, compare, distribution,
   anomalies, summary, compare_periods) + visualization builder
        |
        v
Grounding check, then stream:
   progress stages -> { answer, visualization, table, metadata }
```

1. The browser sends a question and the identifier of the active source.
2. The server applies per-session, per-IP, and per-provider cooldowns, then loads the conversation and the data source.
3. The orchestrator gives the model a compact description of the schema and a fixed set of tools. The loop is bounded to 8 model steps and 5 query attempts per question.
4. Every `run_query` call passes through the Query Guard and the Executor before any rows are returned.
5. Computed facts and a validated visualization specification are produced from the result. The answer text is verified against those facts.
6. The final payload is stored with the conversation and streamed to the browser.

### Components

| Layer | Responsibility | Location |
| --- | --- | --- |
| **Interface** | Chat, source selection, charts, tables, themes | `src/components`, `src/app` |
| **API routes** | Chat streaming, sources, conversations, rate limit status | `src/app/api` |
| **Orchestrator** | Model loop, tool definitions, answer assembly | `src/lib/agent` |
| **Model layer** | Provider abstraction, prompts, fallback chain | `src/lib/ai` |
| **Query Guard and Executor** | SQL parsing and allow-listing, read-only execution | `src/lib/data` |
| **Analysis and visualization** | Deterministic statistics and chart specifications | `src/lib/analysis`, `src/lib/viz` |
| **Security** | Sessions, encryption, rate limits, SSRF protection | `src/lib/security` |
| **Persistence** | Prisma client and application schema | `src/lib/prisma.ts`, `prisma/` |

### Data model

All application metadata lives in the `genviz` schema so that `prisma db push` never alters other schemas in the same database. Uploaded CSV data is stored separately in the `genviz_data` schema, one isolated table per upload.

| Model | Purpose |
| --- | --- |
| `Source` | A CSV upload or a PostgreSQL connection owned by one session. Connection strings are stored encrypted. |
| `Conversation` | A chat thread attached to a source. |
| `Message` | A user or assistant message, including the structured result of an analysis. |
| `QueryRun` | An audit record of every query attempted, with status, row count, and duration. |
| `RateLimit` | Cooldown keys per session, client IP, and provider. |

### API endpoints

| Method and path | Description |
| --- | --- |
| `POST /api/chat` | Ask a question and stream progress and the final result. |
| `GET /api/sources` | List the sources owned by the current session. |
| `POST /api/sources/csv` | Upload and ingest a CSV file. |
| `POST /api/sources/postgres/test` | Test a PostgreSQL connection and preview its tables. |
| `POST /api/sources/postgres` | Save a PostgreSQL connection. |
| `DELETE /api/sources/[id]` | Remove a source and its uploaded data. |
| `GET /api/conversations/[id]` | Restore a saved conversation. |
| `GET /api/rate-limit` | Report the remaining cooldown for the current session. |

## Technology stack

| Area | Technology |
| --- | --- |
| **Framework** | Next.js 15 (App Router), React 19, TypeScript |
| **Interface** | Tailwind CSS, Radix UI primitives, lucide-react, next-themes |
| **Typography** | IBM Plex Sans and IBM Plex Mono through `next/font` |
| **Charts** | VisActor VChart |
| **AI** | Vercel AI SDK with the Groq provider; default model `openai/gpt-oss-120b` |
| **Database** | PostgreSQL, Prisma (application metadata), `pg` (query execution) |
| **SQL safety** | `libpg-query` (the PostgreSQL parser compiled to WebAssembly) |
| **CSV parsing** | PapaParse |
| **Validation** | Zod |
| **Testing** | Vitest |
| **Tooling** | ESLint, Prettier, pnpm |
| **Hosting** | Vercel, with Neon PostgreSQL |

## Getting started

### Prerequisites

- Node.js 20 or later
- [pnpm](https://pnpm.io)
- A PostgreSQL database for Genviz's own data
- A [Groq API key](https://console.groq.com/keys)

### Installation

```bash
git clone https://github.com/waliapriyanshu/GenViz.git
cd GenViz
pnpm install
```

### Configure the environment

```bash
cp .env.example .env.local
```

Open `.env.local` and provide values for `DATABASE_URL`, `GROQ_API_KEY`, `GENVIZ_SESSION_SECRET`, and `GENVIZ_ENCRYPTION_KEY`. Generate each secret yourself:

```bash
openssl rand -base64 32
```

`.env.local` is ignored by git. Never commit it, and never place real values in `.env.example`.

### Create the database tables and start the server

```bash
pnpm db:push    # creates the "genviz" schema tables; other schemas are not touched
pnpm dev        # http://localhost:3000
```

To connect to a database running on `localhost` during development, set `ALLOW_PRIVATE_DB_HOSTS=true`. Do not enable it in production.

### Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the development server. |
| `pnpm build` | Generate the Prisma client and create a production build. |
| `pnpm start` | Serve the production build. |
| `pnpm lint` | Run ESLint. |
| `pnpm typecheck` | Run the TypeScript compiler without emitting files. |
| `pnpm test` | Run the test suite. |
| `pnpm db:push` | Apply `prisma/schema.prisma` to the database. |

## Configuration

All configuration is read from environment variables. `.env.example` is the authoritative template.

### Required

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Connection string for Genviz's own PostgreSQL database. |
| `GROQ_API_KEY` | API key for the model provider. |
| `GENVIZ_SESSION_SECRET` | Secret used to sign the anonymous session cookie. At least 16 characters. |
| `GENVIZ_ENCRYPTION_KEY` | Key used to encrypt stored database connection strings. At least 16 characters. |

### Optional

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_PROVIDER` | `groq` | Model provider. |
| `LLM_MODEL` | `openai/gpt-oss-120b` | Primary model. |
| `LLM_FALLBACK` | none | Comma-separated `provider:model` list tried when the primary model fails. |
| `GROQ_BASE_URL` | none | Alternative base URL, for example an AI gateway. |
| `QUERY_RATE_LIMIT_SECONDS` | `60` | Minimum seconds between questions per session. Use `0` on a paid model tier. |
| `QUERY_IP_RATE_LIMIT_SECONDS` | `10` | Minimum seconds between questions per client IP. |
| `PROVIDER_RATE_LIMIT_FALLBACK_SECONDS` | `30` | Cooldown applied when the provider returns no retry hint. |
| `QUERY_STATEMENT_TIMEOUT_MS` | `10000` | Maximum execution time for one query. |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | Connection timeout when reaching a user's database. |
| `MAX_RESULT_ROWS` | `5000` | Maximum rows returned by one query. |
| `MAX_UPLOAD_BYTES` | `4194304` | Maximum CSV upload size. |
| `MAX_CSV_ROWS` | `200000` | Maximum rows in an uploaded CSV. |
| `ALLOW_PRIVATE_DB_HOSTS` | `false` | Permit connections to private addresses. Development only. |

## Usage

1. Open the application and choose a data source.
   - **Upload a CSV** by dragging a file into the panel or selecting one.
   - **Connect PostgreSQL** by pasting a connection string for a read-only user, testing it, and saving it.
   - **Use the sample data** to explore a bundled set of 1,688 sales orders from 2025 to 2026.
2. Select a suggested question or type your own.
3. Review the answer and chart. Use **View data** to see the table and **How I got this** to see the steps and the exact read-only SQL.
4. Ask follow-up questions in the same conversation, or choose **New chat** to start over.

## Testing

```bash
pnpm test
```

The suite covers the SQL guard, CSV type inference, deterministic analysis and visualization building, the orchestrator (including repair of malformed model output), rate limiting, and request resilience. Database integration tests run only when `TEST_DATABASE_URL` is set. Setting both `TEST_SALES_DB_URL` (a read-only user) and `TEST_SALES_DB_RW_URL` (a read-write user) for a sample customer database enables the additional connection scenarios. Use throwaway databases for these variables, never production data.

Before opening a pull request, run:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

## Deployment

Genviz is designed for Vercel with a hosted PostgreSQL database such as Neon.

1. Set `DATABASE_URL`, `GROQ_API_KEY`, `GENVIZ_SESSION_SECRET`, and `GENVIZ_ENCRYPTION_KEY` in the Vercel project settings. Use values distinct from your development secrets.
2. Run `pnpm db:push` once against the production database from a trusted machine.
3. Deploy. The build runs `prisma generate && next build`.

Operational notes:

- On first use, Genviz creates the `genviz_data` schema and a `genviz_reader` role with no login and `SELECT` access only. Queries over uploaded datasets run as that role. If the database user cannot create roles, queries still run in `READ ONLY` transactions.
- Uploads are limited to about 4 MB because Vercel functions accept request bodies of at most 4.5 MB.
- The Prisma client waits up to 8 seconds to connect, which allows a serverless database to wake from idle.
- Vercel's Hobby plan is intended for non-commercial use.
- Adding a Vercel WAF rate-limit rule for `/api/*` provides an additional layer of protection.

## Security

### Safeguards

| Risk | Mitigation |
| --- | --- |
| Data modification | Only a single `SELECT` passes the Query Guard. Execution uses a `READ ONLY` transaction, a statement timeout, and a row cap. Uploaded data is queried as a `SELECT`-only role. |
| Dangerous SQL | The parser rejects data-changing statements anywhere in the tree, system functions, and table references outside the active source. |
| Server-side request forgery | Hostnames are resolved and rejected if they map to loopback, private, link-local, or cloud metadata addresses. |
| Credential exposure | Connection strings are encrypted with AES-256-GCM, stored on the server, and never returned to the browser. |
| Cross-user access | Every source, conversation, and query is bound to an HMAC-signed session. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Client IPs are stored only as hashes. |
| Fabricated figures | Numbers in answers are verified against query results. Unverified answers are replaced with a computed summary. |
| Abuse and cost | Cooldowns apply per session, per client IP, and per provider. Uploads and result sizes are capped. |

### Credential hygiene

- Secrets are supplied only through environment variables. The application reads no credentials from source files.
- `.env`, `.env.*`, and common key and certificate formats are listed in `.gitignore`. Only `.env.example`, which contains placeholders, is tracked.
- Use a dedicated read-only database user when connecting a database. Genviz warns if the connected user is a superuser or can modify data.
- Rotating `GENVIZ_ENCRYPTION_KEY` makes stored connections unreadable, and users must reconnect.
- If a credential is ever committed, treat it as compromised. Revoke or rotate it with the provider first, then remove it from the repository history. Removing it from history alone does not make it safe, because forks and clones may retain a copy.
- Enable GitHub secret scanning and push protection for the repository to catch accidental commits.

### Reporting a vulnerability

Please report security issues privately through the repository's **Security** tab or by contacting the maintainer directly. Do not open a public issue for a vulnerability.

## Limitations

- Sessions are anonymous and tied to a browser cookie. There are no user accounts, so clearing cookies detaches a browser from its data.
- The default model runs on Groq's free tier, which is rate limited. A cooldown between questions is enforced by default.
- Only PostgreSQL is supported as a live database. Each question produces a single `SELECT` statement.
- CSV uploads are limited to about 4 MB and 200,000 rows by default. Query results are capped at 5,000 rows.
- The interface and prompts are in English.
- Answers are generated by a language model over real query results. Review the displayed SQL before relying on a result for an important decision.

## Project structure

```
.
├── prisma/                  Application schema (schema "genviz")
├── public/samples/          Bundled sample dataset
├── src/
│   ├── app/                 Pages, layout, and API routes
│   ├── components/          Interface components and providers
│   ├── config/              Chart theme configuration
│   ├── hooks/               Shared React hooks
│   ├── lib/
│   │   ├── agent/           Orchestrator, tools, grounding, summaries
│   │   ├── ai/              Provider abstraction and prompts
│   │   ├── analysis/        Deterministic statistics
│   │   ├── client/          Browser-side API helpers and formatting
│   │   ├── data/            Query Guard, executor, CSV ingestion, sources
│   │   ├── security/        Sessions, encryption, rate limits, SSRF checks
│   │   └── viz/             Visualization specification and builder
│   └── style/               Global styles
├── tests/                   Vitest suites
├── licenses/                Third-party license texts
├── .env.example             Environment template (placeholders only)
└── THIRD_PARTY_NOTICES.md   Third-party attributions
```

## Contributing

Contributions are welcome.

1. Fork the repository and create a feature branch.
2. Make focused changes and add or update tests where behavior changes.
3. Run `pnpm lint && pnpm typecheck && pnpm test` and format code with Prettier.
4. Never commit credentials, `.env` files, or database dumps.
5. Open a pull request that describes the change and its motivation.

### Acknowledgments

Genviz builds on [Next.js](https://nextjs.org), the [Vercel AI SDK](https://ai-sdk.dev), [Groq](https://groq.com), [VisActor VChart](https://www.visactor.io/vchart), [libpg-query](https://github.com/pganalyze/libpg_query), [Prisma](https://www.prisma.io), and [Tailwind CSS](https://tailwindcss.com).
