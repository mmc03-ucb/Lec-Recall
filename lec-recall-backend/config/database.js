const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

class Database {
  constructor() {
    this.dbPath = path.join(__dirname, '..', 'database', 'lec_recall.db');
    this.db = new sqlite3.Database(this.dbPath);
  }

  // Initialize database tables
  initialize() {
    return new Promise((resolve, reject) => {
      const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      
      // Split the schema into individual statements and execute them with IF NOT EXISTS
      const statements = schema
        .split(';')
        .map(stmt => stmt.trim())
        .filter(stmt => stmt.length > 0)
        .map(stmt => stmt.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
      
      let completed = 0;
      let hasError = false;
      
      statements.forEach((statement, index) => {
        if (statement.trim()) {
          this.db.run(statement, (err) => {
            completed++;
            if (err && !hasError) {
              console.error(`Error executing statement ${index + 1}:`, err);
              hasError = true;
              reject(err);
            } else if (completed === statements.length && !hasError) {
              console.log('✅ Database initialized successfully');
              resolve();
            }
          });
        } else {
          completed++;
        }
      });
    });
  }

  // Get database instance
  getInstance() {
    return this.db;
  }

  // Close database connection
  close() {
    return new Promise((resolve) => {
      this.db.close((err) => {
        if (err) {
          console.error('Error closing database:', err);
        } else {
          console.log('Database connection closed');
        }
        resolve();
      });
    });
  }
}

module.exports = new Database();
