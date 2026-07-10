// lib/store.js — eenvoudige JSON-bestand opslag (zonder externe dependencies)
// Voor productie / meerdere instances: vervang door PostgreSQL.
// Op Railway: koppel een persistent volume en zet DATA_FILE naar een pad op dat volume.
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');
const EMPTY = { users: [], requests: [], claims: [], meta: { invoiceYear: 0, invoiceSeq: 0 } };

let db;
function load() {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { db = JSON.parse(JSON.stringify(EMPTY)); }
  for (const k of ['users', 'requests', 'claims']) if (!Array.isArray(db[k])) db[k] = [];
  if (!db.meta || typeof db.meta !== 'object') db.meta = { invoiceYear: 0, invoiceSeq: 0 };
  return db;
}
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomair
}
load();

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

module.exports = {
  data: () => db,
  save,
  id,
  // users
  findUserByEmail: (email) => db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase()),
  findUserById: (uid) => db.users.find(u => u.id === uid),
  addUser: (u) => { u.id = id(); u.createdAt = Date.now(); db.users.push(u); save(); return u; },
  // requests
  addRequest: (r) => { r.id = id(); r.createdAt = Date.now(); r.status = 'open'; db.requests.push(r); save(); return r; },
  requestsByCustomer: (cid) => db.requests.filter(r => r.customerId === cid).sort((a, b) => b.createdAt - a.createdAt),
  openRequests: () => db.requests.filter(r => r.status === 'open').sort((a, b) => b.createdAt - a.createdAt),
  findRequest: (rid) => db.requests.find(r => r.id === rid),
  // claims
  claimsByPro: (pid) => db.claims.filter(c => c.proId === pid),
  claimExists: (pid, rid) => db.claims.some(c => c.proId === pid && c.requestId === rid),
  claimsCountByRequest: (rid) => db.claims.filter(c => c.requestId === rid).length,
  addClaim: (c) => { c.id = id(); c.createdAt = Date.now(); db.claims.push(c); save(); return c; },
  // doorlopende factuurnummering: <jaar>-<volgnummer>, reset per jaar
  nextInvoiceNo: () => {
    const y = new Date().getFullYear();
    if (db.meta.invoiceYear !== y) { db.meta.invoiceYear = y; db.meta.invoiceSeq = 0; }
    db.meta.invoiceSeq += 1; save();
    return `${y}-${String(db.meta.invoiceSeq).padStart(5, '0')}`;
  },
};
