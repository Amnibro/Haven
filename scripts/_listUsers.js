'use strict';
const Database = require('better-sqlite3');
const { DB_PATH } = require('../src/paths');
const db = new Database(DB_PATH, { readonly: true });
console.log(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name).join('\n'));
console.log('---users---');
console.log(JSON.stringify(db.prepare('SELECT id, username, display_name, is_admin FROM users').all(), null, 2));
db.close();
