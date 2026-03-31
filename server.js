const express = require('express');
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const mySecretKey = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-prod';

const app = express();

// Vercel serverless functions don't need PORT
// const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Remove SQLite database initialization - using Vercel Postgres now

// Initialize database tables
async function initDatabase() {
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS waitlist (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                phone TEXT,
                shop_type TEXT,
                status TEXT DEFAULT 'pending',
                password_hash TEXT,
                google_id TEXT,
                has_seen_onboarding BOOLEAN DEFAULT false,
                api_key TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS suppliers (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                contact_name TEXT,
                email TEXT,
                phone TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES waitlist(id)
            )
        `;

        await sql`
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES waitlist(id),
                FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
            )
        `;

        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
    }
}

// Call init on startup
initDatabase();

app.post('/api/waitlist', async (req, res) => {
    const { name, email, phone, shop_type } = req.body;

    if (!name || !email || !shop_type) {
        return res.status(400).json({ error: 'Name, email, and shop type are required fields.' });
    }

    try {
        const result = await sql`
            INSERT INTO waitlist (name, email, phone, shop_type)
            VALUES (${name}, ${email}, ${phone}, ${shop_type})
            RETURNING id
        `;

        res.status(201).json({
            message: 'Successfully joined the waitlist.',
            id: result[0].id
        });
    } catch (error) {
        if (error.message.includes('duplicate key value')) {
            return res.status(409).json({ error: 'This email is already on the waitlist.' });
        }
        console.error('Database error:', error);
        return res.status(500).json({ error: 'Internal server error. Please try again later.' });
    }
});

app.get('/api/admin/waitlist', async (req, res) => {
    try {
        const result = await sql`
            SELECT * FROM waitlist ORDER BY created_at DESC
        `;
        res.json(result);
    } catch (error) {
        console.error('Database error:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

app.post('/api/admin/approve/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await sql`
            UPDATE waitlist SET status = 'approved' WHERE id = ${id}
        `;
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        res.json({ message: 'User approved successfully.' });
    } catch (error) {
        console.error('Database error:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
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

app.post('/api/auth/check-email', async (req, res) => {
    const { email } = req.body;
    try {
        const result = await sql`
            SELECT status, password_hash FROM waitlist WHERE email = ${email}
        `;
        if (result.length === 0) {
            return res.status(404).json({ error: 'Account not found.' });
        }
        const row = result[0];
        res.json({
            approved: row.status === 'approved',
            hasPassword: !!row.password_hash
        });
    } catch (error) {
        return res.status(404).json({ error: 'Account not found.' });
    }
});

app.post('/api/auth/setup-password', async (req, res) => {
    const { email, password } = req.body;

    try {
        const userResult = await sql`
            SELECT id, status, password_hash FROM waitlist WHERE email = ${email}
        `;

        if (userResult.length === 0) {
            return res.status(404).json({ error: 'Account not found.' });
        }

        const user = userResult[0];
        if (user.status !== 'approved') {
            return res.status(403).json({ error: 'Your account has not been approved yet.' });
        }
        if (user.password_hash) {
            return res.status(400).json({ error: 'Password already set. Please login.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await sql`
            UPDATE waitlist SET password_hash = ${hashedPassword} WHERE id = ${user.id}
        `;

        const token = jwt.sign({ id: user.id, email }, mySecretKey, { expiresIn: '7d' });
        res.cookie('token', token, { httpOnly: true, secure: false, maxAge: 7*24*60*60*1000 });
        res.json({ message: 'Password established successfully!' });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to save password.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const userResult = await sql`
            SELECT * FROM waitlist WHERE email = ${email}
        `;

        if (userResult.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const user = userResult[0];
        if (user.status !== 'approved') {
            return res.status(403).json({ error: 'Your account has not been approved yet. Please wait for an admin to grant access.' });
        }
        if (!user.password_hash) {
            return res.status(400).json({ error: 'Password not set. Please setup your password first.' });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const token = jwt.sign({ id: user.id, email: user.email }, mySecretKey, { expiresIn: '7d' });
        res.cookie('token', token, { httpOnly: true, secure: false, maxAge: 7*24*60*60*1000 });
        res.json({ message: 'Logged in successfully' });
    } catch (error) {
        return res.status(401).json({ error: 'Invalid email or password.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logged out successfully' });
});

app.get('/api/me', checkUser, async (req, res) => {
    try {
        const result = await sql`
            SELECT id, name, email, shop_type, has_seen_onboarding FROM waitlist WHERE id = ${req.user.id}
        `;
        if (result.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        res.json(result[0]);
    } catch (error) {
        return res.status(404).json({ error: 'User not found.' });
    }
});

app.post('/api/auth/complete-onboarding', checkUser, async (req, res) => {
    try {
        await sql`
            UPDATE waitlist SET has_seen_onboarding = true WHERE id = ${req.user.id}
        `;
        res.json({ message: 'Onboarding completed.' });
    } catch (error) {
        return res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/dashboard/stats', checkUser, async (req, res) => {
    try {
        const [suppliersResult, productsResult, lowStockResult] = await Promise.all([
            sql`SELECT count(*) as count FROM suppliers WHERE user_id = ${req.user.id}`,
            sql`SELECT count(*) as count FROM products WHERE user_id = ${req.user.id}`,
            sql`
                SELECT p.*, s.name as supplier_name, s.phone as supplier_phone
                FROM products p
                LEFT JOIN suppliers s ON p.supplier_id = s.id
                WHERE p.user_id = ${req.user.id} AND p.stock_count <= p.min_limit
                ORDER BY p.stock_count ASC
            `
        ]);

        const suppliersCount = suppliersResult[0]?.count || 0;
        const productsCount = productsResult[0]?.count || 0;
        const lowItems = lowStockResult || [];
        const capitalNeeded = lowItems.reduce((acc, item) => acc + (item.buy_amount * item.unit_cost), 0);

        res.json({
            suppliers_count: suppliersCount,
            products_count: productsCount,
            low_stock_count: lowItems.length,
            capital_needed: capitalNeeded,
            low_stock_items: lowItems
        });
    } catch (error) {
        return res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/suppliers', checkUser, async (req, res) => {
    try {
        const result = await sql`
            SELECT * FROM suppliers WHERE user_id = ${req.user.id} ORDER BY created_at DESC
        `;
        res.json(result);
    } catch (error) {
        return res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/suppliers', checkUser, async (req, res) => {
    const { name, contact_name, email, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Supplier company name is required.' });

    try {
        const result = await sql`
            INSERT INTO suppliers (user_id, name, contact_name, email, phone)
            VALUES (${req.user.id}, ${name}, ${contact_name}, ${email}, ${phone})
            RETURNING id
        `;
        res.json({ id: result[0].id, name, contact_name, email, phone });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to add supplier' });
    }
});

app.get('/api/products', checkUser, async (req, res) => {
    try {
        const result = await sql`
            SELECT p.*, s.name as supplier_name
            FROM products p
            LEFT JOIN suppliers s ON p.supplier_id = s.id
            WHERE p.user_id = ${req.user.id}
            ORDER BY p.name ASC
        `;
        res.json(result);
    } catch (error) {
        return res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/products', checkUser, async (req, res) => {
    const { supplier_id, name, sku, stock_count, min_limit, unit_cost, buy_amount } = req.body;

    if (!supplier_id || !name) return res.status(400).json({ error: 'Supplier and Product Name are strictly required to track an item.' });

    const cs = parseInt(stock_count) || 0;
    const ms = parseInt(min_limit) || 0;
    const uc = parseFloat(unit_cost) || 0;
    const sq = parseInt(buy_amount) || 0;

    if (cs < 0 || ms < 0 || uc < 0 || sq < 0) return res.status(400).json({ error: 'Values cannot be completely negative digits.' });

    try {
        const result = await sql`
            INSERT INTO products (user_id, supplier_id, name, sku, stock_count, min_limit, unit_cost, buy_amount)
            VALUES (${req.user.id}, ${supplier_id}, ${name}, ${sku}, ${cs}, ${ms}, ${uc}, ${sq})
            RETURNING id
        `;
        res.json({ id: result[0].id, message: 'Product successfully added' });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to add product to inventory database.' });
    }
});

app.put('/api/products/:id/stock', checkUser, async (req, res) => {
    const { action } = req.body;
    const productId = req.params.id;

    try {
        const productResult = await sql`
            SELECT stock_count FROM products WHERE id = ${productId} AND user_id = ${req.user.id}
        `;

        if (productResult.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const row = productResult[0];
        let newStock = row.stock_count;
        if (action === 'increment') newStock++;
        else if (action === 'decrement') newStock--;

        if (newStock < 0) return res.status(400).json({ error: 'Current stock cannot be lowered beyond zero.' });

        await sql`
            UPDATE products SET stock_count = ${newStock} WHERE id = ${productId} AND user_id = ${req.user.id}
        `;

        res.json({ stock_count: newStock });
    } catch (error) {
        return res.status(404).json({ error: 'Product not found' });
    }
});

app.get('/api/settings/key', checkUser, async (req, res) => {
    try {
        const result = await sql`
            SELECT api_key FROM waitlist WHERE id = ${req.user.id}
        `;
        res.json({ api_key: result[0]?.api_key || null });
    } catch (error) {
        return res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/settings/generate-key', checkUser, async (req, res) => {
    const crypto = require('crypto');
    const newKey = 'sk_live_' + crypto.randomBytes(16).toString('hex');

    try {
        await sql`
            UPDATE waitlist SET api_key = ${newKey} WHERE id = ${req.user.id}
        `;
        res.json({ api_key: newKey });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to generate integration key' });
    }
});

app.post('/api/integration/sale', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Critcial: Missing x-api-key hardware authorization header' });

    try {
        const userResult = await sql`
            SELECT id FROM waitlist WHERE api_key = ${apiKey}
        `;

        if (userResult.length === 0) {
            return res.status(403).json({ error: 'Fatal: Invalid Hardware API Key. Connection denied.' });
        }

        const user = userResult[0];
        const { sku, qty_sold } = req.body;
        if (!sku || !qty_sold) return res.status(400).json({ error: 'Bad Payload: Missing required SKU string or qty_sold numeric parameters.' });

        const qty = parseInt(qty_sold);
        if (qty <= 0) return res.status(400).json({ error: 'Cannot process a sale of 0 items.' });

        const productResult = await sql`
            SELECT id, name, stock_count FROM products WHERE sku = ${sku} AND user_id = ${user.id}
        `;

        if (productResult.length === 0) {
            return res.status(404).json({ error: `Fatal Sync Error: The external register scanned SKU '${sku}' which DOES NOT EXIST in the StockBridge inventory. Unable to deduct stock.` });
        }

        const product = productResult[0];
        const newStock = Math.max(0, product.stock_count - qty);

        await sql`
            UPDATE products SET stock_count = ${newStock} WHERE id = ${product.id}
        `;

        res.json({ status: 'Success! Deducted internally.', product_name: product.name, remaining_stock: newStock });
    } catch (error) {
        return res.status(500).json({ error: 'Database lock or collision failure while intercepting hardware payload.' });
    }
});

// Remove setInterval - serverless functions don't support long-running processes
// Email notifications should be handled by a separate cron job or scheduled function

// Export the app for Vercel serverless functions
module.exports = app;

// For local development, you can still run the server
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}
