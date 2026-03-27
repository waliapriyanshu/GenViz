# 📊 GenViz AI Analytics

**The ultimate conversational data visualization platform.** 
GenViz AI transforms your natural language questions into stunning, interactive VisActor charts using Google's Gemini 2.5 Flash and PostgreSQL.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Next.js 15](https://img.shields.io/badge/Next.js-15-black)
![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748)
![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL-336791)

---

## 🔥 Key Features

- 👄 **Conversational BI**: Ask "Compare quarterly revenue between iPhone and MacBook" and get an instant Bar Chart.
- 🎙️ **Voice Commands**: Native speech-to-text integration for hands-free data analysis.
- 📁 **Instant CSV Ingestion**: Drag-and-drop any CSV. The system dynamically infers types, creates tables, and batches data into your database.
- 🔌 **Universal Connectors**: One-click connection to any remote PostgreSQL database (Neon, Supabase, RDS, etc.).
- 🎭 **Dynamic Charting**: Automatically maps query results into Bar, Line, Pie, Area, Scatter, or Interactive Tables using `@visactor/vchart`.
- ⚡ **Vercel Optimized**: Built with Next.js App Router for serverless efficiency and edge-ready API routes.

---

## 🏗️ Architecture

GenViz follows a modern decoupled data architecture:

1. **Frontend**: Next.js 15 + Radix UI + Tailwind CSS for a premium, glassmorphism-inspired dark interface.
2. **Brain**: Gemini 2.5 Flash LLM with a highly tuned system prompt for generating secure, read-only PostgreSQL queries.
3. **ORM**: Prisma for schema-first development and automated client generation.
4. **Data Bridge**: 
   - **Local fallback**: Direct CSV-to-SQL ingestion with custom type-mapping and row-stripping logic.
   - **Remote override**: Pass-through query engine for custom PostgreSQL instances.

---

## 🚦 Quick Start

### 1. Clone & Install
```bash
git clone https://github.com/yourusername/genviz.git
cd genviz
npm install --legacy-peer-deps
```

### 2. Environment Variables
Create a `.env.local` file:
```env
GEMINI_API_KEY="your_api_key"
DATABASE_URL="postgresql://user:password@hostname:5432/dbname"
```

### 3. Initialize Database
```bash
npx prisma generate
npx prisma db push
node prisma/seed.js
```

### 4. Launch
```bash
npm run dev
```

---

## 🛠 Deployment (Vercel)

GenViz was specifically engineered for Vercel's Serverless architecture.

1. **Push to GitHub**: Connect your repo to Vercel.
2. **Environment Variables**: Add `GEMINI_API_KEY` and `DATABASE_URL` in the Vercel dashboard.
3. **Build Sequence**: The project uses a custom build script: `prisma generate && next build`.

---

## 🔒 Security First

- **Read-Only Guards**: The system strictly validates generated SQL to prevent `DROP`, `DELETE`, `UPDATE`, or `INSERT` operations.
- **Identifier Scoping**: All table and column names are sanitized and double-quoted to prevent SQL injection and handle PostgreSQL case-sensitivity.
- **Environment Isolation**: API keys are never exposed to the client; all LLM operations happen in secure Serverless Functions.

---

## 📜 Acknowledgments

- **VisActor Team**: For the incredible `@visactor/vchart` charting engine.
- **Google GenAI**: For the Gemini 2.5 Flash capabilities.
- **Created with ❤️ by Priyanshu**

---

*For any updates, please check the [Walkthrough](./walkthrough.md) of the implementation phase.*
