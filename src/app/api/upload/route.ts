import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import Papa from 'papaparse';

const prisma = new PrismaClient();

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const text = await file.text();
    const result = Papa.parse(text, { header: true, skipEmptyLines: true });
    const data = result.data as Record<string, any>[];
    const headers = result.meta.fields || [];

    if (headers.length === 0 || data.length === 0) {
      return NextResponse.json({ error: 'Valid CSV with headers and data required' }, { status: 400 });
    }

    // Sanitize headers to valid SQLite column names
    const safeHeaders = headers.map(h => 
      h.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
    );

    const tableName = 'UploadedData';

    // 1. Drop existing table if mapped
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${tableName}`);

    // 2. Create the table
    // Intelligently guess types (numeric vs text) based on the first row
    const columns = safeHeaders.map((col, idx) => {
      const firstVal = data[0][headers[idx]];
      let type = 'TEXT';
      if (firstVal && !isNaN(Number(firstVal))) {
        type = 'NUMERIC';
      }
      return `${col} ${type}`;
    });

    const createStmt = `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${columns.join(', ')})`;
    await prisma.$executeRawUnsafe(createStmt);

    // 3. Batch Insert
    // For simplicity / MVP, we'll do raw inserts parameterizing per row or batch insert manually using raw SQLite
    const insertCols = safeHeaders.join(', ');
    const placeholders = safeHeaders.map(() => '?').join(', ');
    
    const insertQuery = `INSERT INTO ${tableName} (${insertCols}) VALUES (${placeholders})`;
    
    let rowsInserted = 0;
    for (const row of data) {
      const values = headers.map(h => {
        const val = row[h];
        if (val === undefined || val === null || val === '') return null;
        if (!isNaN(Number(val))) return Number(val);
        return val.toString();
      });
      
      try {
        await prisma.$executeRawUnsafe(insertQuery, ...values);
        rowsInserted++;
      } catch (err) {
        console.error("Row insert failure:", err);
      }
    }

    return NextResponse.json({ 
      success: true, 
      message: `Created table ${tableName} and inserted ${rowsInserted} rows.`,
      schema: columns
    });
  } catch (err: any) {
    console.error('Upload Error:', err);
    return NextResponse.json({ error: 'File processing failed', details: err.message }, { status: 500 });
  }
}
