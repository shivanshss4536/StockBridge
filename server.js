const express = require('express');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const mySecretKey = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-prod';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

let db;
let isPostgres = false;

if (process.env.DATABASE_URL) {
    isPostgres = true;
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    db = {
        run: (sql, params, callback) => {
            let count = 0;
            let postgresSql = sql.replace(/\?/g, () => `$${++count}`).replace(/AUTOINCREMENT/g, 'SERIAL');
            if (postgresSql.toLowerCase().includes('insert into')) {
                postgresSql += ' RETURNING id';
            }
            pool.query(postgresSql, params)
                .then(res => { if (callback) callback.call({ lastID: res.rows[0]?.id, changes: res.rowCount }, null); })
                .catch(err => { if (callback) callback(err); });
        },
        get: (sql, params, callback) => {
            let count = 0;
            const postgresSql = sql.replace(/\?/g, () => `$${++count}`);
            pool.query(postgresSql, params)
                .then(res => { if (callback) callback(null, res.rows[0]); })
                .catch(err => { if (callback) callback(err); });
        },
        all: (sql, params, callback) => {
            let count = 0;
            const postgresSql = sql.replace(/\?/g, () => `$${++count}`);
            pool.query(postgresSql, params)
                .then(res => { if (callback) callback(null, res.rows); })
                .catch(err => { if (callback) callback(err); });
        }
    };
    console.log('Connected to the PostgreSQL (Neon) database.');
    initTables();
} else {
    const dbPath = path.join(__dirname, 'database.sqlite');
    const sqliteDatabase = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('Error connecting to SQLite:', err.message);
        } else {
            console.log('Connected to the local SQLite database.');
            initTables();
        }
    });

    db = {
        run: (sql, params, callback) => sqliteDatabase.run(sql, params, callback),
        get: (sql, params, callback) => sqliteDatabase.get(sql, params, callback),
        all: (sql, params, callback) => sqliteDatabase.all(sql, params, callback)
    };
}

function initTables() {
    db.run(`
        CREATE TABLE IF NOT EXISTS waitlist (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            phone TEXT,
            shop_type TEXT,
            status TEXT DEFAULT 'pending',
            password_hash TEXT,
            google_id TEXT,
            has_seen_onboarding BOOLEAN DEFAULT FALSE,
            api_key TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, [], (err) => {
        if (!err) {
            
            db.run('ALTER TABLE waitlist ADD COLUMN status TEXT DEFAULT "pending"', [], () => {});
            db.run('ALTER TABLE waitlist ADD COLUMN password_hash TEXT', [], () => {});
            db.run('ALTER TABLE waitlist ADD COLUMN google_id TEXT', [], () => {});
            db.run('ALTER TABLE waitlist ADD COLUMN has_seen_onboarding BOOLEAN DEFAULT FALSE', [], () => {});
            db.run('ALTER TABLE waitlist ADD COLUMN api_key TEXT', [], () => {});
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS suppliers (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            contact_name TEXT,
            email TEXT,
            phone TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS products (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            supplier_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sku TEXT,
            stock_count INTEGER DEFAULT 0,
            min_limit INTEGER DEFAULT 0,
            unit_cost REAL DEFAULT 0,
            buy_amount INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, [], (err) => {
         if (!err) {
             db.run('ALTER TABLE products ADD COLUMN unit_cost REAL DEFAULT 0', [], () => {});
             db.run('ALTER TABLE products ADD COLUMN buy_amount INTEGER DEFAULT 0', [], () => {});
         }
    });
}

app.post('/api/waitlist', (req, res) => {
    const { name, email, phone, shop_type } = req.body;

    if (!name || !email || !shop_type) {
        return res.status(400).json({ error: 'Name, email, and shop type are required fields.' });
    }

    const sql = `INSERT INTO waitlist (name, email, phone, shop_type) VALUES (?, ?, ?, ?)`;
    const params = [name, email, phone, shop_type];

    db.run(sql, params, function(err) {
        if (err) {
            
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ error: 'This email is already on the waitlist.' });
            }
            console.error('Database error:', err.message);
            return res.status(500).json({ error: 'Internal server error. Please try again later.' });
        }
        res.status(201).json({ 
            message: 'Successfully joined the waitlist.',
            id: this.lastID 
        });
    });
});

app.get('/api/admin/waitlist', (req, res) => {
    const sql = `SELECT * FROM waitlist ORDER BY created_at DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Database error:', err.message);
            return res.status(500).json({ error: 'Internal server error.' });
        }
        res.json(rows);
    });
});

app.post('/api/admin/approve/:id', (req, res) => {
    const { id } = req.params;
    const sql = `UPDATE waitlist SET status = 'approved' WHERE id = ?`;
    db.run(sql, [id], function(err) {
        if (err) {
            console.error('Database error:', err.message);
            return res.status(500).json({ error: 'Internal server error.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        res.json({ message: 'User approved successfully.' });
    });
});

function checkUser(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Access denied. You must be logged in.' });
    
    jwt.verify(token, mySecretKey, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired session.' });
        req.user = user;
        next();
    });
}

app.post('/api/auth/check-email', (req, res) => {
    const { email } = req.body;
    db.get(`SELECT status, password_hash FROM waitlist WHERE email = ?`, [email], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Account not found.' });
        
        res.json({
            approved: row.status === 'approved',
            hasPassword: !!row.password_hash
        });
    });
});

app.post('/api/auth/setup-password', async (req, res) => {
    const { email, password } = req.body;
    
    db.get(`SELECT id, status, password_hash FROM waitlist WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'Account not found.' });
        if (user.status !== 'approved') return res.status(403).json({ error: 'Your account has not been approved yet.' });
        if (user.password_hash) return res.status(400).json({ error: 'Password already set. Please login.' });
        
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        
        db.run(`UPDATE waitlist SET password_hash = ? WHERE id = ?`, [hashedPassword, user.id], function(err) {
            if (err) return res.status(500).json({ error: 'Failed to save password.' });

            const token = jwt.sign({ id: user.id, email }, mySecretKey, { expiresIn: '7d' });
            res.cookie('token', token, { httpOnly: true, secure: false, maxAge: 7*24*60*60*1000 });
            res.json({ message: 'Password established successfully!' });
        });
    });
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    
    db.get(`SELECT * FROM waitlist WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Invalid email or password.' });
        if (user.status !== 'approved') return res.status(403).json({ error: 'Your account has not been approved yet. Please wait for an admin to grant access.' });
        if (!user.password_hash) return res.status(400).json({ error: 'Password not set. Please setup your password first.' });
        
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(401).json({ error: 'Invalid email or password.' });
        
        const token = jwt.sign({ id: user.id, email: user.email }, mySecretKey, { expiresIn: '7d' });
        res.cookie('token', token, { httpOnly: true, secure: false, maxAge: 7*24*60*60*1000 });
        res.json({ message: 'Logged in successfully' });
    });
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logged out successfully' });
});

app.get('/api/me', checkUser, (req, res) => {
    db.get(`SELECT id, name, email, shop_type, has_seen_onboarding FROM waitlist WHERE id = ?`, [req.user.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'User not found.' });
        res.json(row);
    });
});

app.post('/api/auth/complete-onboarding', checkUser, (req, res) => {
    db.run(`UPDATE waitlist SET has_seen_onboarding = 1 WHERE id = ?`, [req.user.id], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ message: 'Onboarding completed.' });
    });
});

app.get('/api/dashboard/stats', checkUser, (req, res) => {
    db.get(`SELECT count(*) as count FROM suppliers WHERE user_id = ?`, [req.user.id], (err, supRow) => {
        db.get(`SELECT count(*) as count FROM products WHERE user_id = ?`, [req.user.id], (err, prodRow) => {
            db.all(`
                SELECT p.*, s.name as supplier_name, s.phone as supplier_phone
                FROM products p 
                LEFT JOIN suppliers s ON p.supplier_id = s.id 
                WHERE p.user_id = ? AND p.stock_count <= p.min_limit
                ORDER BY p.stock_count ASC
            `, [req.user.id], (err, lowRows) => {
                const lowItems = lowRows || [];
                const capitalNeeded = lowItems.reduce((acc, item) => acc + (item.buy_amount * item.unit_cost), 0);
                res.json({
                    suppliers_count: supRow ? supRow.count : 0,
                    products_count: prodRow ? prodRow.count : 0,
                    low_stock_count: lowItems.length,
                    capital_needed: capitalNeeded,
                    low_stock_items: lowItems
                });
            });
        });
    });
});

app.get('/api/suppliers', checkUser, (req, res) => {
    db.all(`SELECT * FROM suppliers WHERE user_id = ? ORDER BY created_at DESC`, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

app.post('/api/suppliers', checkUser, (req, res) => {
    const { name, contact_name, email, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Supplier company name is required.' });
    
    db.run(
        `INSERT INTO suppliers (user_id, name, contact_name, email, phone) VALUES (?, ?, ?, ?, ?)`,
        [req.user.id, name, contact_name, email, phone],
        function(err) {
            if (err) return res.status(500).json({ error: 'Failed to add supplier' });
            res.json({ id: this.lastID || null, name, contact_name, email, phone });
        }
    );
});

app.get('/api/products', checkUser, (req, res) => {
    db.all(`
        SELECT p.*, s.name as supplier_name 
        FROM products p 
        LEFT JOIN suppliers s ON p.supplier_id = s.id 
        WHERE p.user_id = ? 
        ORDER BY p.name ASC
    `, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

app.post('/api/products', checkUser, (req, res) => {
    const { supplier_id, name, sku, stock_count, min_limit, unit_cost, buy_amount } = req.body;
    
    if (!supplier_id || !name) return res.status(400).json({ error: 'Supplier and Product Name are strictly required to track an item.' });
    
    const cs = parseInt(stock_count) || 0;
    const ms = parseInt(min_limit) || 0;
    const uc = parseFloat(unit_cost) || 0;
    const sq = parseInt(buy_amount) || 0;

    if (cs < 0 || ms < 0 || uc < 0 || sq < 0) return res.status(400).json({ error: 'Values cannot be completely negative digits.' });
    
    db.run(
        `INSERT INTO products (user_id, supplier_id, name, sku, stock_count, min_limit, unit_cost, buy_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, supplier_id, name, sku, cs, ms, uc, sq],
        function(err) {
            if (err) return res.status(500).json({ error: 'Failed to add product to inventory database.' });
            res.json({ id: this.lastID || null, message: 'Product successfully added' });
        }
    );
});

app.put('/api/products/:id/stock', checkUser, (req, res) => {
    const { action } = req.body; 
    const productId = req.params.id;
    
    db.get(`SELECT stock_count FROM products WHERE id = ? AND user_id = ?`, [productId, req.user.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Product not found' });
        
        let newStock = row.stock_count;
        if (action === 'increment') newStock++;
        else if (action === 'decrement') newStock--;
        
        if (newStock < 0) return res.status(400).json({ error: 'Current stock cannot be lowered beyond zero.' });
        
        db.run(`UPDATE products SET stock_count = ? WHERE id = ? AND user_id = ?`, [newStock, productId, req.user.id], (err) => {
            if (err) return res.status(500).json({ error: 'Failed to safely update live stock' });
            res.json({ stock_count: newStock });
        });
    });
});

app.get('/api/settings/key', checkUser, (req, res) => {
    db.get(`SELECT api_key FROM waitlist WHERE id = ?`, [req.user.id], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ api_key: row ? row.api_key : null });
    });
});

app.post('/api/settings/generate-key', checkUser, (req, res) => {
    const crypto = require('crypto');
    const newKey = 'sk_live_' + crypto.randomBytes(16).toString('hex');
    db.run(`UPDATE waitlist SET api_key = ? WHERE id = ?`, [newKey, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to generate integration key' });
        res.json({ api_key: newKey });
    });
});

app.post('/api/integration/sale', (req, res) => {
    
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Critcial: Missing x-api-key hardware authorization header' });

    db.get(`SELECT id FROM waitlist WHERE api_key = ?`, [apiKey], (err, user) => {
        if (err || !user) return res.status(403).json({ error: 'Fatal: Invalid Hardware API Key. Connection denied.' });
        
        const { sku, qty_sold } = req.body;
        if (!sku || !qty_sold) return res.status(400).json({ error: 'Bad Payload: Missing required SKU string or qty_sold numeric parameters.' });
        
        const qty = parseInt(qty_sold);
        if (qty <= 0) return res.status(400).json({ error: 'Cannot process a sale of 0 items.' });

        db.get(`SELECT id, name, stock_count FROM products WHERE sku = ? AND user_id = ?`, [sku, user.id], (err, product) => {
            if (err || !product) {
                return res.status(404).json({ error: `Fatal Sync Error: The external register scanned SKU '${sku}' which DOES NOT EXIST in the StockBridge inventory. Unable to deduct stock.` });
            }
            
            const newStock = Math.max(0, product.stock_count - qty);
            
            db.run(`UPDATE products SET stock_count = ? WHERE id = ?`, [newStock, product.id], (err) => {
                if (err) return res.status(500).json({ error: 'Database lock or collision failure while intercepting hardware payload.' });
                
                res.json({ status: 'Success! Deducted internally.', product_name: product.name, remaining_stock: newStock });
            });
        });
    });
});

setInterval(() => {
    db.all(`
        SELECT p.name, p.stock_count, p.sku, s.name as supplier, s.email 
        FROM products p 
        LEFT JOIN suppliers s ON p.supplier_id = s.id 
        WHERE p.stock_count <= p.min_limit
    `, [], (err, rows) => {
        if (!err && rows && rows.length > 0) {
            console.log(`[AUTO] Detected ${rows.length} critical items. sending emails...`);
            rows.forEach(r => {
                if(r.email) {
                    console.log(` > Sending automated email to ${r.supplier} (${r.email}) regarding SKU: ${r.sku} (${r.name}).`);
                }
            });
        }
    });
}, 1000 * 60 * 60);

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
