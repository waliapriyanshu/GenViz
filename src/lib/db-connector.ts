import { Pool } from 'pg';

export async function getPostgresSchema(connectionString: string): Promise<string> {
  const pool = new Pool({ connectionString });
  try {
    const res = await pool.query(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
    `);
    
    const tables: Record<string, string[]> = {};
    for (const row of res.rows) {
      const tName = row.table_name || row.tableName;
      const cName = row.column_name || row.columnName;
      const dType = row.data_type || row.dataType;
      
      if (!tables[tName]) {
        tables[tName] = [];
      }
      tables[tName].push(`- ${cName} (${dType})`);
    }

    let schemaBlock = "";
    for (const [tableName, columns] of Object.entries(tables)) {
      schemaBlock += `Table Name: ${tableName}\nColumns:\n${columns.join('\n')}\n\n`;
    }

    return schemaBlock || "No public tables found in the database.";
  } finally {
    await pool.end();
  }
}

export async function executePostgresQuery(connectionString: string, safeSql: string): Promise<any[]> {
  const pool = new Pool({ connectionString });
  try {
    const res = await pool.query(safeSql);
    return res.rows;
  } finally {
    await pool.end();
  }
}
