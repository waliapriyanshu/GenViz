# GenViz Analytics (Next.js + VisActor + Gemini)

GenViz Analytics is an AI-powered conversational data dashboard. Simply ask questions about your data using text or **Voice**, and the system intelligently converts your input into a secure SQL query, executes it against your database, and maps the result into a beautiful visualization using VisActor (`@visactor/react-vchart`).

---

## 🛠 Features pipeline
1. **Frontend**: Next.js (App Router), Tailwind CSS, and Radix UI.
2. **Natural Language**: Gemini 3 Flash Intent Parsing (`@google/generative-ai`).
3. **Database Layer**: Dual-architecture supporting both local SQLite (via Prisma) and remote PostgreSQL (`pg`).
4. **Data Visualization**: VChart mapped automatically to `bar`, `line`, `pie`, `area`, `scatter`, or `table`.

### ✨ New: Bring Your Own Data
1. **Upload CSVs**: Instantly upload any `.csv` file directly from the dashboard. The system will automatically parse and ingest it into a local SQLite table, exposing it to Gemini's SQL generator.
2. **Connect Remote Databases**: Click the `Database` icon on the dashboard to enter a PostgreSQL connection string (e.g. `postgresql://user:pass@localhost:5432/db`). Your queries will seamlessly switch from local CSVs to querying your live production schemas!

---

## 🚀 Setup & Installation

### 1. Install Dependencies
```bash
npm install --legacy-peer-deps
```

### 2. Configure Environment Variables
Create a file named `.env.local` in the root directory.
```env
# Google Gemini API Key
GEMINI_API_KEY="AIzaSyBoGJGEMQUyaS..."

# Local SQLite Store (Used for seeded data and uploading CSV files)
DATABASE_URL="file:./dev.db"
```

### 3. Initialize the Local Database
Push the schema to your database and run the data seeder:
```bash
npx prisma db push
node prisma/seed.js
```
*This populates your database with example eCommerce data (Laptops, Phones, Monitors, etc.) so you have immediate records to test.*

### 4. Run the Development Server
```bash
npm run dev
```

Visit `http://localhost:3000` to interact with GenViz!
