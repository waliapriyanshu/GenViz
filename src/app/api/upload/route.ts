import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';
import { Pool } from 'pg';

const prisma = new PrismaClient();

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const customDbUrl = formData.get('customDatabaseUrl') as string | null;
    
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const text = await file.text();
    const result = Papa.parse(text, { 
      header: true, 
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });
    const data = (result.data as Record<string, any>[]).map(row => {
      const trimmedRow: any = {};
      for (const key in row) {
        trimmedRow[key] = typeof row[key] === 'string' ? row[key].trim() : row[key];
      }
      return trimmedRow;
    });
    const headers = (result.meta.fields || []).map(h => h.trim());

    if (headers.length === 0 || data.length === 0) {
      return NextResponse.json({ error: 'Valid CSV with headers and data required' }, { status: 400 });
    }

    // Sanitize headers to valid column names
    const safeHeaders = headers.map(h => 
      h.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
    );

    const tableName = 'UploadedData';
    // Robust type inference: check first 50 rows
    const columns = safeHeaders.map((col, idx) => {
      let isNumeric = true;
      const sampleSize = Math.min(data.length, 50);
      
      for (let i = 0; i < sampleSize; i++) {
        const val = String(data[i][headers[idx]] || "").replace(/[$,]/g, "").trim();
        if (val && isNaN(Number(val))) {
          isNumeric = false;
          break;
        }
        // If sample is just empty strings, don't assume numeric yet
      }
      
      const type = isNumeric && data.some(d => d[headers[idx]] !== "") ? 'NUMERIC' : 'TEXT';
      return `"${col}" ${type}`;
    });

    const insertCols = safeHeaders.map(h => `"${h}"`).join(', ');
    let rowsInserted = 0;

    // --- POSTGRES ENGINE (Vercel Production Compatible) ---
    if (customDbUrl) {
      const pool = new Pool({ connectionString: customDbUrl });
      
      try {
        await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
        const createStmt = `CREATE TABLE "${tableName}" (id SERIAL PRIMARY KEY, ${columns.join(', ')})`;
        await pool.query(createStmt);

        const placeholders = safeHeaders.map((_, i) => `$${i + 1}`).join(', ');
        const insertQuery = `INSERT INTO "${tableName}" (${insertCols}) VALUES (${placeholders})`;

        for (const row of data) {
          const values = headers.map(h => {
            const val = String(row[h] || "").replace(/[$,]/m, "").trim();
            if (val === '') return null;
            if (!isNaN(Number(val)) && val !== '') return Number(val);
            return row[h];
          });
          
          await pool.query(insertQuery, values);
          rowsInserted++;
        }
      } catch (err: any) {
        console.error("PG Processing failure:", err);
        return NextResponse.json({ error: 'Database processing failed', details: err.message }, { status: 500 });
      } finally {
        await pool.end();
      }

      return NextResponse.json({ 
        success: true, 
        message: `Created remote Postgres table "${tableName}" and inserted ${rowsInserted} rows.`,
        tableName,
        rows: rowsInserted
      });
    }

    // --- GLOBAL POSTGRES ENGINE (via Prisma Default) ---
    try {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tableName}"`);
      const createStmt = `CREATE TABLE "${tableName}" (id SERIAL PRIMARY KEY, ${columns.join(', ')})`;
      await prisma.$executeRawUnsafe(createStmt);

      const placeholders = safeHeaders.map((_, i) => `$${i + 1}`).join(', ');
      const insertQuery = `INSERT INTO "${tableName}" (${insertCols}) VALUES (${placeholders})`;
      
      for (const row of data) {
        const values = headers.map(h => {
          const val = String(row[h] || "").replace(/[$,]/m, "").trim();
          if (val === '') return null;
          if (!isNaN(Number(val)) && val !== '') return Number(val);
          return row[h];
        });
        
        await prisma.$executeRawUnsafe(insertQuery, ...values);
        rowsInserted++;
      }
    } catch (err: any) {
      console.error("Prisma Processing failure:", err);
      return NextResponse.json({ error: 'Database processing failed', details: err.message }, { status: 500 });
    }

    return NextResponse.json({ 
      success: true, 
      message: `Created global Postgres table "${tableName}" and inserted ${rowsInserted} rows.`,
      tableName,
      rows: rowsInserted,
      schema: columns
    });

  } catch (err: any) {
    console.error('Upload Error:', err);
    return NextResponse.json({ error: 'File processing failed', details: err.message }, { status: 500 });
  }
}
