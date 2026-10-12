# Genviz — talk to your data

Upload a CSV or connect a PostgreSQL database, ask questions in plain English, and get a short answer with a chart and the underlying data. Genviz only ever **reads** your data.

- **Conversational**: follow-ups like "only for 2026" or "compare that with last year" build on the previous analysis.
- **Grounded**: every number comes from a real query; the model never does arithmetic, and answers that mention numbers not found in the results are replaced with a computed summary.
- **Safe by construction**: model-written SQL passes a real PostgreSQL parser (single `SELECT`, allowed tables only, dangerous functions blocked) and runs in a `READ ONLY` transaction with timeouts and row caps.
- **Cheap**: runs on Groq's free tier with the open-weight `openai/gpt-oss-120b`; the provider is configurable.

## How it works

```
Browser (chat UI) ──POST /api/chat──▶ rate limit (session, IP, provider) ─▶ load conversation + data source
                                                    │
                                   Orchestrator (AI SDK, bounded tool loop, gpt-oss-120b on Groq)
                     get_schema · profile_column · run_query · analyze_data · make_visualization · final_answer
                                                    │ run_query
                           Query Guard (libpg-query AST)  ─▶  Executor (READ ONLY txn, statement timeout,
                                                                row cap, SELECT-only role for uploads)
                                                    │
                          Deterministic analysis (trend, top/shares, anomalies…) + visualization builder
                                                    │
                     NDJSON stream: progress stages → { answer, visualization, table, metadata }
```

- **CSV mode**: files are parsed server-side, typed from *all* rows (dates, currency, percentages, booleans, codes) and loaded atomically into an isolated table (`genviz_data.ds_<id>`). The model sees it as `dataset`.
- **Database mode**: connection strings are tested (with SSRF protection), encrypted with AES-256-GCM and stored server-side; they are never kept in the browser.
- **Isolation**: every source, conversation and query belongs to an anonymous, signed session cookie.

## Local development

Requirements: Node 20+, pnpm, a PostgreSQL database for Genviz itself, a Groq API key.

```bash
pnpm install
cp .env.example .env.local        # fill in DATABASE_URL, GROQ_API_KEY and the two secrets
pnpm db:push                      # creates the "genviz" schema tables (does not touch other schemas)
pnpm dev
```

To connect to a database on `localhost` during development, set `ALLOW_PRIVATE_DB_HOSTS=true` (never in production).

### Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript |
| `pnpm test` | Unit tests; DB integration tests also run when `TEST_DATABASE_URL` (and optionally `TEST_SALES_DB_URL`, `TEST_SALES_DB_RW_URL`) are set |
| `pnpm db:push` | Apply `prisma/schema.prisma` (schema `genviz` only) |

## Deploying to Vercel

1. Set environment variables in the Vercel project: `DATABASE_URL`, `GROQ_API_KEY`, `GENVIZ_SESSION_SECRET`, `GENVIZ_ENCRYPTION_KEY` (and optionally `QUERY_RATE_LIMIT_SECONDS`).
2. Run `pnpm db:push` once against the production database (from your machine with `DATABASE_URL` pointing to it).
3. Deploy. The build runs `prisma generate && next build`.

Notes:
- On first use Genviz creates the `genviz_data` schema and a `genviz_reader` NOLOGIN role (SELECT-only) that uploaded-dataset queries run as. If the database user cannot create roles, queries still run in `READ ONLY` transactions.
- Uploads are limited to ~4 MB because Vercel functions accept at most 4.5 MB request bodies.
- The Hobby plan is for non-commercial use; see the audit for the cost model.
- Recommended: add a Vercel WAF rate-limit rule on `/api/*` as an extra layer.

## Security checklist

- Rotate any database credential that was ever committed (the old `.env` was tracked in git history).
- Use a read-only database user when connecting a database; Genviz warns if the user can write.
- `GENVIZ_ENCRYPTION_KEY` protects stored connection strings; changing it makes existing connections unreadable (users reconnect).

## Third-party notices

The logo mark is an unmodified icon from IBM's Carbon Design System (Apache-2.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
