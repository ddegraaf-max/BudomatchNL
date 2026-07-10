// lib/db.js — PostgreSQL-opslag (productie). Zelfde interface als lib/store.js,
// maar async. Wordt automatisch gebruikt zodra DATABASE_URL is gezet (Railway
// PostgreSQL-plugin zet die variabele). Zonder DATABASE_URL gebruikt de server
// het JSON-bestand (lib/store.js) — handig voor lokaal draaien.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  max: 5,
});

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Schema eenmalig aanmaken (idempotent)
const ready = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      data JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      status TEXT,
      data JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_customer_idx ON requests (customer_id);
    CREATE INDEX IF NOT EXISTS requests_status_idx   ON requests (status);
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      pro_id TEXT,
      request_id TEXT,
      data JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS claims_pro_idx ON claims (pro_id);
    CREATE INDEX IF NOT EXISTS claims_req_idx ON claims (request_id);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      request_id TEXT,
      pro_id TEXT,
      data JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (request_id, pro_id);
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      pro_id TEXT,
      customer_id TEXT,
      request_id TEXT,
      data JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reviews_pro_idx ON reviews (pro_id);
    CREATE TABLE IF NOT EXISTS projobs (
      id TEXT PRIMARY KEY,
      poster_pro_id TEXT,
      taken_by_pro_id TEXT,
      status TEXT,
      data JSONB NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projobs_status_idx ON projobs (status);
    CREATE TABLE IF NOT EXISTS invoice_counter (
      year INTEGER PRIMARY KEY,
      seq  INTEGER NOT NULL DEFAULT 0
    );
  `);
  console.log('[db] PostgreSQL schema gereed');
})();

const q = async (text, params) => { await ready; return pool.query(text, params); };

module.exports = {
  _pg: true,
  id,
  // ---- users ----
  async findUserByEmail(email) {
    const r = await q('SELECT data FROM users WHERE lower(email)=lower($1) LIMIT 1', [String(email)]);
    return r.rows[0] ? r.rows[0].data : undefined;
  },
  async findUserById(uid) {
    const r = await q('SELECT data FROM users WHERE id=$1 LIMIT 1', [uid]);
    return r.rows[0] ? r.rows[0].data : undefined;
  },
  async listPros() {
    const r = await q("SELECT data FROM users WHERE data->>'role' = 'pro'");
    return r.rows.map(x => x.data);
  },
  async addUser(u) {
    u.id = id(); u.createdAt = Date.now();
    await q('INSERT INTO users (id, email, data, created_at) VALUES ($1,$2,$3,$4)',
      [u.id, u.email, JSON.stringify(u), u.createdAt]);
    return u;
  },
  async updateUser(uid, patch) {
    const r = await q('SELECT data FROM users WHERE id=$1 LIMIT 1', [uid]);
    if (!r.rows[0]) return undefined;
    const u = Object.assign(r.rows[0].data, patch);
    await q('UPDATE users SET data=$2 WHERE id=$1', [uid, JSON.stringify(u)]);
    return u;
  },
  // ---- requests ----
  async addRequest(r) {
    r.id = id(); r.createdAt = Date.now(); r.status = 'open';
    await q('INSERT INTO requests (id, customer_id, status, data, created_at) VALUES ($1,$2,$3,$4,$5)',
      [r.id, r.customerId, r.status, JSON.stringify(r), r.createdAt]);
    return r;
  },
  async requestsByCustomer(cid) {
    const r = await q('SELECT data FROM requests WHERE customer_id=$1 ORDER BY created_at DESC', [cid]);
    return r.rows.map(x => x.data);
  },
  async openRequests() {
    const r = await q("SELECT data FROM requests WHERE status='open' ORDER BY created_at DESC");
    return r.rows.map(x => x.data);
  },
  async findRequest(rid) {
    const r = await q('SELECT data FROM requests WHERE id=$1 LIMIT 1', [rid]);
    return r.rows[0] ? r.rows[0].data : undefined;
  },
  // ---- claims ----
  async claimsByPro(pid) {
    const r = await q('SELECT data FROM claims WHERE pro_id=$1', [pid]);
    return r.rows.map(x => x.data);
  },
  async claimsByRequest(rid) {
    const r = await q('SELECT data FROM claims WHERE request_id=$1', [rid]);
    return r.rows.map(x => x.data);
  },
  async claimExists(pid, rid) {
    const r = await q('SELECT 1 FROM claims WHERE pro_id=$1 AND request_id=$2 LIMIT 1', [pid, rid]);
    return r.rowCount > 0;
  },
  async claimsCountByRequest(rid) {
    const r = await q('SELECT COUNT(*)::int AS n FROM claims WHERE request_id=$1', [rid]);
    return r.rows[0].n;
  },
  async addClaim(c) {
    c.id = id(); c.createdAt = Date.now();
    await q('INSERT INTO claims (id, pro_id, request_id, data, created_at) VALUES ($1,$2,$3,$4,$5)',
      [c.id, c.proId, c.requestId, JSON.stringify(c), c.createdAt]);
    return c;
  },
  // ---- messages (chat) ----
  async addMessage(m) {
    m.id = id(); m.createdAt = Date.now();
    await q('INSERT INTO messages (id, request_id, pro_id, data, created_at) VALUES ($1,$2,$3,$4,$5)',
      [m.id, m.requestId, m.proId, JSON.stringify(m), m.createdAt]);
    return m;
  },
  async messagesByThread(rid, pid) {
    const r = await q('SELECT data FROM messages WHERE request_id=$1 AND pro_id=$2 ORDER BY created_at ASC', [rid, pid]);
    return r.rows.map(x => x.data);
  },
  async findMessage(mid) {
    const r = await q('SELECT data FROM messages WHERE id=$1 LIMIT 1', [mid]);
    return r.rows[0] ? r.rows[0].data : undefined;
  },
  async updateMessage(mid, patch) {
    const r = await q('SELECT data FROM messages WHERE id=$1 LIMIT 1', [mid]);
    if (!r.rows[0]) return undefined;
    const m = Object.assign(r.rows[0].data, patch);
    await q('UPDATE messages SET data=$2 WHERE id=$1', [mid, JSON.stringify(m)]);
    return m;
  },
  // ---- reviews ----
  async addReview(rv) {
    rv.id = id(); rv.createdAt = Date.now();
    await q('INSERT INTO reviews (id, pro_id, customer_id, request_id, data, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [rv.id, rv.proId, rv.customerId, rv.requestId, JSON.stringify(rv), rv.createdAt]);
    return rv;
  },
  async reviewsByPro(pid) {
    const r = await q('SELECT data FROM reviews WHERE pro_id=$1 ORDER BY created_at DESC', [pid]);
    return r.rows.map(x => x.data);
  },
  async reviewExists(cid, pid, rid) {
    const r = await q('SELECT 1 FROM reviews WHERE customer_id=$1 AND pro_id=$2 AND request_id=$3 LIMIT 1', [cid, pid, rid]);
    return r.rowCount > 0;
  },
  // ---- projobs (vakman -> vakman) ----
  async addProJob(j) {
    j.id = id(); j.createdAt = Date.now(); j.status = 'open';
    await q('INSERT INTO projobs (id, poster_pro_id, taken_by_pro_id, status, data, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [j.id, j.posterProId, j.takenByProId || null, j.status, JSON.stringify(j), j.createdAt]);
    return j;
  },
  async findProJob(jid) {
    const r = await q('SELECT data FROM projobs WHERE id=$1 LIMIT 1', [jid]);
    return r.rows[0] ? r.rows[0].data : undefined;
  },
  async openProJobs() {
    const r = await q("SELECT data FROM projobs WHERE status='open' ORDER BY created_at DESC");
    return r.rows.map(x => x.data);
  },
  async proJobsForPro(pid) {
    const r = await q('SELECT data FROM projobs WHERE poster_pro_id=$1 OR taken_by_pro_id=$1 ORDER BY created_at DESC', [pid]);
    return r.rows.map(x => x.data);
  },
  async updateProJob(jid, patch) {
    const r = await q('SELECT data FROM projobs WHERE id=$1 LIMIT 1', [jid]);
    if (!r.rows[0]) return undefined;
    const j = Object.assign(r.rows[0].data, patch);
    await q('UPDATE projobs SET taken_by_pro_id=$2, status=$3, data=$4 WHERE id=$1',
      [jid, j.takenByProId || null, j.status, JSON.stringify(j)]);
    return j;
  },
  async deleteProJob(jid) {
    const r = await q('DELETE FROM projobs WHERE id=$1', [jid]);
    return r.rowCount > 0;
  },
  // ---- doorlopende factuurnummering: <jaar>-<volgnummer>, gapless per jaar ----
  async nextInvoiceNo() {
    await ready;
    const y = new Date().getFullYear();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO invoice_counter (year, seq) VALUES ($1,0) ON CONFLICT (year) DO NOTHING', [y]);
      const r = await client.query('UPDATE invoice_counter SET seq = seq + 1 WHERE year=$1 RETURNING seq', [y]);
      await client.query('COMMIT');
      return `${y}-${String(r.rows[0].seq).padStart(5, '0')}`;
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
  },
};
