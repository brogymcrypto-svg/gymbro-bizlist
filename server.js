const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TREASURY_WALLET = process.env.TREASURY_WALLET || '0x4Ab8A42a868d95093145b9CB93bFF69924C11042';
const GYMBRO_CONTRACT = '0x8514e54af85db0fda7c30ae4530a0bb4b48b9e5e';
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || '';

// ── INIT DATABASE ─────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      order_ref VARCHAR(20) UNIQUE NOT NULL,
      business_name VARCHAR(200) NOT NULL,
      partner_type VARCHAR(20) NOT NULL,
      tier VARCHAR(20) NOT NULL,
      duration_months INTEGER NOT NULL,
      total_gymbro NUMERIC NOT NULL,
      exact_amount NUMERIC NOT NULL,
      category VARCHAR(50),
      city VARCHAR(100),
      country VARCHAR(100),
      location_region VARCHAR(50),
      contact_link VARCHAR(300),
      email VARCHAR(200),
      bio TEXT,
      services TEXT,
      social VARCHAR(200),
      website VARCHAR(300),
      status VARCHAR(20) DEFAULT 'pending',
      start_date TIMESTAMP,
      expiry_date TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER REFERENCES listings(id),
      order_ref VARCHAR(20),
      tx_hash VARCHAR(100),
      amount_gymbro NUMERIC,
      received_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER REFERENCES listings(id),
      sent_at TIMESTAMP DEFAULT NOW(),
      reminder_type VARCHAR(50)
    );
  `);
  console.log("✅ Database initialized");
  await initLogoTable();
}

// ── GENERATE ORDER REF ────────────────────────────────────────
async function generateOrderRef() {
  const res = await pool.query('SELECT COUNT(*) FROM listings');
  const count = parseInt(res.rows[0].count) + 1;
  return 'GBL-' + String(count).padStart(4, '0');
}

// ── GENERATE EXACT AMOUNT (with decimal ref) ──────────────────
function generateExactAmount(total, orderNum) {
  const decimal = (orderNum / 10000).toFixed(4);
  return parseFloat(total) + parseFloat(decimal);
}

// ── DETECT REGION ─────────────────────────────────────────────
function detectRegion(city) {
  const gcc = ['riyadh','jeddah','dubai','abu dhabi','doha','kuwait','muscat','bahrain','manama'];
  const europe = ['london','paris','berlin','madrid','rome','amsterdam','zurich','milan'];
  const asia = ['singapore','kuala lumpur','bangkok','tokyo','hong kong','mumbai','jakarta','manila'];
  const americas = ['new york','los angeles','toronto','sao paulo','miami','chicago'];
  const c = city.toLowerCase();
  if (gcc.some(x => c.includes(x))) return 'gcc';
  if (europe.some(x => c.includes(x))) return 'europe';
  if (asia.some(x => c.includes(x))) return 'asia';
  if (americas.some(x => c.includes(x))) return 'americas';
  return 'global';
}

// ── CREATE LISTING ORDER ──────────────────────────────────────
app.post('/listings/create', async (req, res) => {
  try {
    const { business_name, partner_type, tier, duration_months, total_gymbro,
            category, city, email, contact_link, bio, services, social } = req.body;
    const order_ref = await generateOrderRef();
    const orderNum = parseInt(order_ref.replace('GBL-', ''));
    const exact_amount = generateExactAmount(total_gymbro, orderNum);
    const location_region = detectRegion(city || '');
    const country = (city || '').split(',').pop().trim();

    await pool.query(`
      INSERT INTO listings (order_ref, business_name, partner_type, tier, duration_months,
        total_gymbro, exact_amount, category, city, country, location_region,
        contact_link, email, bio, services, social, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending')`,
      [order_ref, business_name, partner_type, tier, duration_months,
       total_gymbro, exact_amount, category, city, country, location_region,
       contact_link, email, bio, services, social]);

    res.json({ order_ref, exact_amount, treasury_wallet: TREASURY_WALLET });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ── GET ORDER DETAILS ─────────────────────────────────────────
app.get('/listings/order/:ref', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM listings WHERE order_ref=$1', [req.params.ref]);
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ── CHECK PAYMENT STATUS ──────────────────────────────────────
app.get('/listings/status/:ref', async (req, res) => {
  try {
    const result = await pool.query('SELECT status, start_date, expiry_date FROM listings WHERE order_ref=$1', [req.params.ref]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ── GET ACTIVE LISTINGS ───────────────────────────────────────
app.get('/listings/active', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM listings
      WHERE status='active' AND expiry_date > NOW()
      ORDER BY tier='premium' DESC, tier='standard' DESC, created_at DESC`);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// ── MORALIS WEBHOOK — PAYMENT DETECTION ──────────────────────
app.post('/webhook/payment', async (req, res) => {
  try {
    const txns = req.body;
    for (const tx of (Array.isArray(txns) ? txns : [txns])) {
      if (!tx || !tx.logs) continue;
      for (const log of tx.logs) {
        if (!log.address || log.address.toLowerCase() !== GYMBRO_CONTRACT.toLowerCase()) continue;
        const toAddress = '0x' + log.topic2?.slice(26);
        if (toAddress.toLowerCase() !== TREASURY_WALLET.toLowerCase()) continue;
        const rawAmount = parseInt(log.data, 16);
        const amount = rawAmount / 1e18;
        console.log('Payment detected:', amount, '$GYMBRO');
        await matchAndActivate(amount, tx.hash);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).json({ error: 'Webhook failed' });
  }
});

// ── MATCH PAYMENT TO ORDER & ACTIVATE ────────────────────────
async function matchAndActivate(amount, txHash) {
  try {
    const result = await pool.query(`
      SELECT * FROM listings
      WHERE status='pending'
      AND ABS(exact_amount - $1) < 0.001
      ORDER BY created_at ASC LIMIT 1`, [amount]);
    if (!result.rows.length) { console.log('No matching order for amount:', amount); return; }
    const listing = result.rows[0];
    const start = new Date();
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + listing.duration_months);
    await pool.query(`
      UPDATE listings SET status='active', start_date=$1, expiry_date=$2 WHERE id=$3`,
      [start, expiry, listing.id]);
    await pool.query(`
      INSERT INTO payments (listing_id, order_ref, tx_hash, amount_gymbro)
      VALUES ($1,$2,$3,$4)`,
      [listing.id, listing.order_ref, txHash, amount]);
    console.log('✅ Listing activated:', listing.order_ref, '| Expires:', expiry);
  } catch (e) {
    console.error('Activation error:', e);
  }
}

// ── DAILY EXPIRY CHECK ────────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  console.log('Running daily expiry check...');
  await pool.query(`UPDATE listings SET status='expired' WHERE status='active' AND expiry_date < NOW()`);
  console.log('✅ Expired listings updated');
  await sendRenewalReminders();
});

// ── RENEWAL REMINDERS (7 days before expiry) ─────────────────
async function sendRenewalReminders() {
  const result = await pool.query(`
    SELECT l.* FROM listings l
    WHERE l.status='active'
    AND l.expiry_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
    AND NOT EXISTS (
      SELECT 1 FROM reminders r
      WHERE r.listing_id=l.id AND r.reminder_type='renewal'
      AND r.sent_at > NOW() - INTERVAL '7 days'
    )`);
  for (const listing of result.rows) {
    console.log('Renewal reminder for:', listing.business_name, listing.email);
    await pool.query(`INSERT INTO reminders (listing_id, reminder_type) VALUES ($1,'renewal')`, [listing.id]);
  }
}

// ── ADMIN — ALL LISTINGS ──────────────────────────────────────
app.get('/admin/listings', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const result = await pool.query('SELECT * FROM listings ORDER BY created_at DESC');
  res.json(result.rows);
});

// ── ADMIN — STATS ─────────────────────────────────────────────
app.get('/admin/stats', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const stats = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='active') as active,
      COUNT(*) FILTER (WHERE status='pending') as pending,
      COUNT(*) FILTER (WHERE status='expired') as expired,
      COUNT(DISTINCT country) FILTER (WHERE status='active') as countries,
      SUM(total_gymbro) FILTER (WHERE status='active') as total_gymbro_locked
    FROM listings`);
  res.json(stats.rows[0]);
});

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'gymbro-bizlist' }));

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`🚀 gymbro-bizlist running on port ${PORT}`);
});

// ── DB MIGRATION — add new columns ────────────────────────────
app.post('/admin/migrate', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500),
        ADD COLUMN IF NOT EXISTS phone VARCHAR(100),
        ADD COLUMN IF NOT EXISTS website VARCHAR(300),
        ADD COLUMN IF NOT EXISTS opening_hours VARCHAR(200),
        ADD COLUMN IF NOT EXISTS experience VARCHAR(100),
        ADD COLUMN IF NOT EXISTS certifications TEXT,
        ADD COLUMN IF NOT EXISTS logo_path VARCHAR(500);
    `);
    res.json({ ok: true, message: 'Migration complete' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LOGO UPLOAD ───────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    const dir = '/tmp/logos';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    const allowed = /jpeg|jpg|png/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

app.post('/upload/logo', upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fileName = req.file.filename;
    const fileData = fs.readFileSync(req.file.path);
    const base64 = fileData.toString('base64');
    const mimeType = req.file.mimetype;
    const dataUrl = `data:${mimeType};base64,${base64}`;
    await pool.query(
      'INSERT INTO logo_uploads (filename, data_url, uploaded_at) VALUES ($1,$2,NOW()) ON CONFLICT DO NOTHING',
      [fileName, dataUrl]
    );
    res.json({ url: `https://listings.gymbrocrypto.com/logo/${fileName}`, filename: fileName });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/logo/:filename', async (req, res) => {
  try {
    const result = await pool.query('SELECT data_url FROM logo_uploads WHERE filename=$1', [req.params.filename]);
    if (!result.rows.length) return res.status(404).send('Not found');
    const dataUrl = result.rows[0].data_url;
    const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    res.set('Content-Type', mimeType);
    res.send(buffer);
  } catch(e) {
    res.status(500).send('Error');
  }
});

// ── LOGO UPLOADS TABLE ────────────────────────────────────────
async function initLogoTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logo_uploads (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(200) UNIQUE,
      data_url TEXT,
      uploaded_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Logo uploads table ready');
}

// ── ADMIN UPDATE LOGO ─────────────────────────────────────────
app.post('/admin/update-logo', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { order_ref, logo_url } = req.body;
    await pool.query('UPDATE listings SET logo_url=$1 WHERE order_ref=$2', [logo_url, order_ref]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
