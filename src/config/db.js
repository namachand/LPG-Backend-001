import pg from 'pg';

// Configure node-postgres to return 1 and 0 for boolean types to match MySQL TINYINT(1)
pg.types.setTypeParser(16, (val) => {
    return val === 't' ? 1 : 0;
});

const connectionUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;

const poolConfig = connectionUrl
  ? { 
      connectionString: connectionUrl,
      // Supabase requires SSL for remote connections
      ssl: { rejectUnauthorized: false } 
    }
  : {
      host: process.env.PGHOST || process.env.DB_HOST || "localhost",
      user: process.env.PGUSER || process.env.DB_USER || "postgres",
      password: process.env.PGPASSWORD || process.env.DB_PASSWORD || "postgres",
      database: process.env.PGDATABASE || process.env.DB_NAME || "postgres",
      port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
    };

const pool = new pg.Pool(poolConfig);

// Utility to convert MySQL "?" placeholders to PostgreSQL "$1, $2" placeholders
function convertQuery(sql) {
    let i = 1;
    // Split by single quotes to handle string literals
    const parts = sql.split("'");
    for (let j = 0; j < parts.length; j++) {
        // Only replace ? in SQL code (even indices), not inside string literals (odd indices)
        if (j % 2 === 0) {
            parts[j] = parts[j].replace(/\?/g, () => `$${i++}`);
        }
    }
    return parts.join("'");
}

const db = {
    execute: async (sql, params = []) => {
        const client = await pool.connect();
        try {
            // Hardcode agency_id to 1 for backwards compatibility with single-tenant codebase
            await client.query("SET LOCAL app.current_agency_id = 1");
            
            let pgSql = convertQuery(sql);
            
            const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
            // Auto-append RETURNING id for INSERT queries if not present
            if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
                pgSql += ' RETURNING id';
            }
            
            const result = await client.query(pgSql, params);
            
            // Mimic mysql2's return format: [rows, fields] or [header, fields]
            if (isInsert) {
                return [{ 
                    insertId: result.rows.length > 0 ? result.rows[0].id : 0, 
                    affectedRows: result.rowCount 
                }, result.fields];
            }
            
            if (result.command === 'UPDATE' || result.command === 'DELETE') {
                return [{ affectedRows: result.rowCount }, result.fields];
            }
            
            return [result.rows, result.fields];
        } catch (error) {
            console.error("DB Execute Error:", error.message, "\nQuery:", sql, "\nParams:", params);
            throw error;
        } finally {
            client.release();
        }
    },
    
    query: async (sql, params = []) => {
        return db.execute(sql, params);
    },
    
    getConnection: async () => {
        const client = await pool.connect();
        return {
            query: async (sql, params = []) => {
                try {
                    await client.query("SET LOCAL app.current_agency_id = 1");
                    
                    let pgSql = convertQuery(sql);
                    const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
                    if (isInsert && !pgSql.toUpperCase().includes('RETURNING')) {
                        pgSql += ' RETURNING id';
                    }
                    
                    const result = await client.query(pgSql, params);
                    
                    if (isInsert) {
                        return [{ 
                            insertId: result.rows.length > 0 ? result.rows[0].id : 0, 
                            affectedRows: result.rowCount 
                        }, result.fields];
                    }
                    if (result.command === 'UPDATE' || result.command === 'DELETE') {
                        return [{ affectedRows: result.rowCount }, result.fields];
                    }
                    return [result.rows, result.fields];
                } catch (error) {
                    console.error("Connection Query Error:", error.message, "\nQuery:", sql, "\nParams:", params);
                    throw error;
                }
            },
            execute: async function(sql, params = []) {
                return this.query(sql, params);
            },
            beginTransaction: async () => {
                await client.query('BEGIN');
            },
            commit: async () => {
                await client.query('COMMIT');
            },
            rollback: async () => {
                await client.query('ROLLBACK');
            },
            release: () => {
                client.release();
            }
        };
    },
    
    pool: pool
};

export default db;
