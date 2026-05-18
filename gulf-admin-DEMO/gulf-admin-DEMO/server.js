/**
 * نظام الخليج للخدمات الإدارية - سيرفر الشبكة الداخلية
 * Gulf Admin Accounting System - DEMO VERSION (7 days / 20 transactions)
 * Node.js + Express + sql.js (pure JS SQLite)
 */

const express = require('express');
const crypto  = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3001; // Railway injects PORT automatically

// ── DEMO LIMITS ────────────────────────────────────────────────────────────
const DEMO_DAYS = 7;
const DEMO_MAX_TXN = 20;
const DEMO_MAX_CLIENTS = 15;
// Use /tmp on cloud hosts (Railway/Render), local data/ otherwise
const IS_CLOUD = process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.NODE_ENV === 'production';
const DB_PATH = IS_CLOUD
  ? path.join('/tmp', 'gulf_admin_demo.db')
  : path.join(__dirname, 'data', 'gulf_admin.db');

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ── Simple session store (in-memory, keyed by token) ───────────────────────
const sessions = new Map();
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function hashPw(pw)   { return crypto.createHash('sha256').update(pw + 'gulf_salt_2025').digest('hex'); }

function queryRaw(sql, params=[]) {
  try { if (!db) return []; const s=db.prepare(sql); s.bind(params); const r=[]; while(s.step()) r.push(s.getAsObject()); s.free(); return r; } catch(e){ return []; }
}

// Auth middleware — skips login page, static assets, and /api/auth routes
function requireAuth(req, res, next) {
  const open = ['/api/auth/login', '/api/auth/check', '/login.html', '/demo-expired.html'];
  if (open.includes(req.path)) return next();
  const token = req.headers['x-auth-token'] || req.query._t;
  if (token && sessions.has(token)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/login.html');
}
app.use(requireAuth);

// ── Demo expiry + limits middleware ─────────────────────────────────────────
function getDemoStart() {
  const rows = queryRaw('SELECT value FROM settings WHERE key=?', ['demo_start']);
  if (rows.length) return new Date(JSON.parse(rows[0].value));
  const now = new Date().toISOString();
  db.run("INSERT OR IGNORE INTO settings(key,value) VALUES('demo_start',?)", [JSON.stringify(now)]);
  saveDB();
  return new Date(now);
}

function isDemoExpired() {
  try {
    const start = getDemoStart();
    const diffDays = (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays > DEMO_DAYS;
  } catch(e) { return false; }
}

function requireDemo(req, res, next) {
  const skip = ['/api/auth/login','/api/auth/check','/api/demo/status','/login.html','/demo-expired.html'];
  if (skip.some(p => req.path.startsWith(p))) return next();
  if (isDemoExpired()) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'demo_expired', message: 'انتهت نسخة الديمو' });
    return res.redirect('/demo-expired.html');
  }
  next();
}
app.use(requireDemo);

app.use(express.static(path.join(__dirname, 'public')));

// ── Database Setup (sql.js) ─────────────────────────────────────────────────
const initSqlJs = require('sql.js');

let db;
let SQL;

async function setupDB() {
  SQL = await initSqlJs();
  
  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      tier TEXT DEFAULT 'normal',
      nationality TEXT,
      passport TEXT,
      phone TEXT,
      dob TEXT,
      employer TEXT,
      expiry TEXT,
      visaType TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT,
      gov REAL DEFAULT 0,
      office REAL DEFAULT 0,
      days INTEGER DEFAULT 7
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clientId INTEGER,
      clientName TEXT,
      svcId INTEGER,
      svcName TEXT,
      svcType TEXT,
      govFee REAL DEFAULT 0,
      officeFee REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      payment TEXT,
      date TEXT,
      status TEXT DEFAULT 'paid',
      ref TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      category TEXT,
      amount REAL DEFAULT 0,
      date TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed default services
  const count = db.exec("SELECT COUNT(*) as c FROM services")[0]?.values[0][0] || 0;
  if (count === 0) {
    const defaultServices = [
      ['تجديد إقامة عمل - سنتان','residence',2100,300,7],
      ['استخراج إقامة جديدة - عامل','residence',3200,400,14],
      ['تجديد إقامة عائلية - سنتان','residence',1850,250,7],
      ['إقامة مستثمر - 3 سنوات','residence',4500,600,14],
      ['تأشيرة زيارة 30 يوم','visa',300,150,3],
      ['تأشيرة زيارة 60 يوم','visa',550,180,4],
      ['تأشيرة زيارة 90 يوم','visa',800,200,5],
      ['تمديد تأشيرة زيارة','visa',600,150,3],
      ['تأشيرة عمل','visa',1200,350,7],
      ['تصديق عقد عمل - وزارة الموارد البشرية','labor',220,150,3],
      ['استخراج بطاقة عمل','labor',350,200,7],
      ['تسوية نزاع عمالي','labor',0,500,14],
      ['تصديق شهادة دراسية','attest',150,100,5],
      ['تصديق شهادة طبية','attest',150,100,5],
      ['إلغاء إقامة','residence',100,150,3],
      ['شهادة راتب - خدمة إدارية','other',50,80,1],
      ['ترجمة وثائق رسمية','other',0,150,2],
      ['استشارة قانونية','other',0,200,1],
    ];
    const stmt = db.prepare('INSERT INTO services (name,type,gov,office,days) VALUES (?,?,?,?,?)');
    defaultServices.forEach(row => stmt.run(row));
    stmt.free();
    saveDB();
    console.log('✅ تم إضافة الخدمات الافتراضية');
  }

  // ── Seed demo clients + transactions + expenses ────────────────────────
  const clientCount = db.exec("SELECT COUNT(*) as c FROM clients")[0]?.values[0][0] || 0;
  if (clientCount === 0) {
    console.log('🌱 جاري إضافة البيانات التجريبية...');

    const demoClients = [
      ['محمد عبدالله الزهراني','vip','سعودي','A12345678','0501234567','1985-03-15','شركة الخليج للتجارة','2025-08-20','work','عميل منذ 3 سنوات'],
      ['رحيم بهادر خان','normal','باكستاني','PK9876543','0551234567','1990-07-22','مطعم الأصيل','2024-12-10','work',''],
      ['سانتياغو روميرو','vip','فلبيني','PA5432167','0521234567','1988-11-05','فندق برج الخليج','2025-06-30','work','يجدد سنوياً بانتظام'],
      ['فاطمة أحمد العلي','normal','إماراتية','UAE123456','0561234567','1992-04-18','ربة منزل','2025-11-15','family',''],
      ['راجيف شارما','new','هندي','IN8765432','0531234567','1995-09-30','مؤسسة البناء الحديث','2024-11-05','work','عميل جديد هذا الشهر'],
      ['ماريا خوسيه','normal','فلبينية','PA1234598','0541234567','1993-01-25','عائلة الشمري','2025-03-22','work',''],
      ['عبدالرحمن محمود','vip','مصري','EG2345678','0571234567','1980-06-12','مجموعة النور للاستثمار','2026-02-28','investor','عميل VIP رجل أعمال'],
      ['ديفيد أندرسون','normal','بريطاني','UK3456789','0581234567','1987-08-19','شركة التقنية المتقدمة','2025-09-15','work',''],
      ['نور الدين حسين','inactive','سوداني','SD4567890','0511234567','1983-12-03','مقاول أعمال','2024-06-01','work','غير نشط - انتهت إقامته'],
      ['أنابيل كروز','normal','فلبينية','PA9876512','0591234567','1998-05-14','عائلة المنصوري','2025-07-18','work',''],
      ['كارلوس مارتينيز','vip','إسباني','ES5678901','0521122334','1975-02-28','شركة الإنشاءات الدولية','2026-05-10','investor','رجل أعمال - VIP'],
      ['ليلى عبدالله','normal','أردنية','JO6789012','0561122334','1991-10-07','مستشفى الخليج','2025-04-30','work',''],
    ];
    const clStmt = db.prepare('INSERT INTO clients (name,tier,nationality,passport,phone,dob,employer,expiry,visaType,notes) VALUES (?,?,?,?,?,?,?,?,?,?)');
    demoClients.forEach(c => clStmt.run(c));
    clStmt.free();

    const d = (n) => { const dt=new Date(); dt.setDate(dt.getDate()-n); return dt.toISOString().split('T')[0]; };

    const demoTxns = [
      [1,'محمد عبدالله الزهراني',1,'تجديد إقامة عمل - سنتان','residence',2100,300,100,2300,'cash',d(180),'paid'],
      [2,'رحيم بهادر خان',2,'استخراج إقامة جديدة - عامل','residence',3200,400,0,3600,'transfer',d(165),'paid'],
      [3,'سانتياغو روميرو',10,'تصديق عقد عمل','labor',220,150,0,370,'cash',d(150),'paid'],
      [4,'فاطمة أحمد العلي',3,'تجديد إقامة عائلية - سنتان','residence',1850,250,0,2100,'card',d(140),'paid'],
      [5,'راجيف شارما',9,'تأشيرة عمل','visa',1200,350,0,1550,'transfer',d(130),'paid'],
      [7,'عبدالرحمن محمود',4,'إقامة مستثمر - 3 سنوات','residence',4500,600,200,4900,'transfer',d(120),'paid'],
      [6,'ماريا خوسيه',1,'تجديد إقامة عمل - سنتان','residence',2100,300,0,2400,'cash',d(110),'paid'],
      [8,'ديفيد أندرسون',13,'تصديق شهادة دراسية','attest',150,100,0,250,'card',d(100),'paid'],
      [11,'كارلوس مارتينيز',17,'ترجمة وثائق رسمية','other',0,150,0,150,'cash',d(95),'paid'],
      [1,'محمد عبدالله الزهراني',6,'تأشيرة زيارة 60 يوم','visa',550,180,50,680,'cash',d(85),'paid'],
      [12,'ليلى عبدالله',11,'استخراج بطاقة عمل','labor',350,200,0,550,'transfer',d(75),'paid'],
      [3,'سانتياغو روميرو',1,'تجديد إقامة عمل - سنتان','residence',2100,300,100,2300,'cash',d(70),'paid'],
      [5,'راجيف شارما',10,'تصديق عقد عمل','labor',220,150,0,370,'transfer',d(60),'paid'],
      [7,'عبدالرحمن محمود',18,'استشارة قانونية','other',0,200,0,200,'cash',d(55),'paid'],
      [10,'أنابيل كروز',2,'استخراج إقامة جديدة - عامل','residence',3200,400,0,3600,'transfer',d(45),'paid'],
      [2,'رحيم بهادر خان',8,'تمديد تأشيرة زيارة','visa',600,150,0,750,'cash',d(38),'paid'],
      [11,'كارلوس مارتينيز',4,'إقامة مستثمر - 3 سنوات','residence',4500,600,300,4800,'transfer',d(30),'paid'],
      [4,'فاطمة أحمد العلي',13,'تصديق شهادة دراسية','attest',150,100,0,250,'card',d(22),'paid'],
      [12,'ليلى عبدالله',3,'تجديد إقامة عائلية - سنتان','residence',1850,250,0,2100,'transfer',d(15),'paid'],
      [5,'راجيف شارما',9,'تأشيرة عمل','visa',1200,350,0,1550,'transfer',d(7),'pending'],
    ];
    const txStmt = db.prepare('INSERT INTO transactions (clientId,clientName,svcId,svcName,svcType,govFee,officeFee,discount,total,payment,date,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    demoTxns.forEach(t => txStmt.run(t));
    txStmt.free();

    const demoExp = [
      ['إيجار المكتب - يناير','rent',3500,d(170),''],
      ['رواتب الموظفين - يناير','salary',8000,d(165),''],
      ['فاتورة الكهرباء','utilities',450,d(160),''],
      ['إيجار المكتب - فبراير','rent',3500,d(140),''],
      ['رواتب الموظفين - فبراير','salary',8000,d(135),''],
      ['مستلزمات مكتبية','other',280,d(125),'طباعة وقرطاسية'],
      ['صيانة الحاسوب','other',350,d(110),''],
      ['إيجار المكتب - مارس','rent',3500,d(110),''],
      ['رواتب الموظفين - مارس','salary',8000,d(105),''],
      ['إيجار المكتب - أبريل','rent',3500,d(80),''],
      ['رواتب الموظفين - أبريل','salary',8000,d(75),''],
      ['تسويق ودعاية','other',600,d(65),'سوشيال ميديا'],
      ['إيجار المكتب - مايو','rent',3500,d(50),''],
      ['رواتب الموظفين - مايو','salary',8000,d(45),''],
      ['فاتورة الكهرباء','utilities',390,d(40),''],
      ['إيجار المكتب - يونيو','rent',3500,d(20),''],
      ['رواتب الموظفين - يونيو','salary',8000,d(15),''],
    ];
    const expStmt = db.prepare('INSERT INTO expenses (description,category,amount,date,notes) VALUES (?,?,?,?,?)');
    demoExp.forEach(e => expStmt.run(e));
    expStmt.free();

    const demoSettings = {
      officeName:'مكتب الخليج للخدمات الإدارية',
      license:'CN-2024-88741', phone:'+971-4-123-4567', mobile:'+971-50-123-4567',
      email:'info@gulfadmin.ae', address:'برج الخليج، شارع الشيخ زايد',
      emirate:'دبي', invPrefix:'GA-', invNext:1021, currency:'AED',
      vat:5, trn:'100432187300003',
      bankName:'بنك الإمارات دبي الوطني', iban:'AE07 0331 2345 6789 0123 456',
      invFooter:'شكراً لتعاملكم معنا — نسعد بخدمتكم دائماً'
    };
    Object.entries(demoSettings).forEach(([k,v]) => {
      db.run("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", [k, JSON.stringify(v)]);
    });

    saveDB();
    console.log('✅ تم إضافة البيانات التجريبية (12 عميل / 20 معاملة / 17 مصروف)');
  }

  console.log('✅ قاعدة البيانات جاهزة');
}

// Save DB to file after each write
function saveDB() {
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Helper: run query and return rows as objects
function query(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch(e) {
    console.error('DB query error:', e.message, sql);
    return [];
  }
}

function run(sql, params = []) {
  try {
    db.run(sql, params);
    saveDB();
    // Get last insert rowid
    const res = db.exec("SELECT last_insert_rowid() as id");
    return res[0]?.values[0][0] || null;
  } catch(e) {
    console.error('DB run error:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════
// API Routes (registered after DB is ready)
// ══════════════════════════════════════════════════════

function registerRoutes() {
  // ── Settings ────────────────────────────────────────────────────────────────
  app.get('/api/settings', (req, res) => {
    const rows = query('SELECT key, value FROM settings');
    const obj = {};
    rows.forEach(r => { try { obj[r.key] = JSON.parse(r.value); } catch { obj[r.key] = r.value; } });
    res.json(obj);
  });

  app.post('/api/settings', (req, res) => {
    Object.entries(req.body).forEach(([k, v]) => {
      db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
    });
    saveDB();
    res.json({ ok: true });
  });

  // ── Clients ─────────────────────────────────────────────────────────────────
  app.get('/api/clients', (req, res) => {
    res.json(query('SELECT * FROM clients ORDER BY id DESC'));
  });

  app.post('/api/clients', (req, res) => {
    const clCount = query('SELECT COUNT(*) as c FROM clients')[0]?.c || 0;
    if (clCount >= DEMO_MAX_CLIENTS) return res.status(403).json({ error:'demo_limit', message:`وصلت للحد الأقصى في نسخة الديمو (${DEMO_MAX_CLIENTS} عميل)` });
    const { name, tier, nationality, passport, phone, dob, employer, expiry, visaType, notes } = req.body;
    const id = run(`INSERT INTO clients (name,tier,nationality,passport,phone,dob,employer,expiry,visaType,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [name, tier||'normal', nationality||'', passport||'', phone||'', dob||'', employer||'', expiry||'', visaType||'', notes||'']);
    res.json({ id, ...req.body });
  });

  app.put('/api/clients/:id', (req, res) => {
    const { name, tier, nationality, passport, phone, dob, employer, expiry, visaType, notes } = req.body;
    db.run(`UPDATE clients SET name=?,tier=?,nationality=?,passport=?,phone=?,dob=?,employer=?,expiry=?,visaType=?,notes=? WHERE id=?`,
      [name, tier||'normal', nationality||'', passport||'', phone||'', dob||'', employer||'', expiry||'', visaType||'', notes||'', req.params.id]);
    saveDB();
    res.json({ ok: true });
  });

  app.delete('/api/clients/:id', (req, res) => {
    db.run('DELETE FROM clients WHERE id=?', [req.params.id]);
    saveDB();
    res.json({ ok: true });
  });

  // ── Services ─────────────────────────────────────────────────────────────────
  app.get('/api/services', (req, res) => {
    res.json(query('SELECT * FROM services ORDER BY id ASC'));
  });

  app.post('/api/services', (req, res) => {
    const { name, type, gov, office, days } = req.body;
    const id = run('INSERT INTO services (name,type,gov,office,days) VALUES (?,?,?,?,?)',
      [name, type||'other', gov||0, office||0, days||7]);
    res.json({ id, ...req.body });
  });

  app.put('/api/services/:id', (req, res) => {
    const { name, type, gov, office, days } = req.body;
    db.run('UPDATE services SET name=?,type=?,gov=?,office=?,days=? WHERE id=?',
      [name, type||'other', gov||0, office||0, days||7, req.params.id]);
    saveDB();
    res.json({ ok: true });
  });

  app.delete('/api/services/:id', (req, res) => {
    db.run('DELETE FROM services WHERE id=?', [req.params.id]);
    saveDB();
    res.json({ ok: true });
  });

  // ── Transactions ─────────────────────────────────────────────────────────────
  app.get('/api/transactions', (req, res) => {
    res.json(query('SELECT * FROM transactions ORDER BY id DESC'));
  });

  app.post('/api/transactions', (req, res) => {
    const txnCount = query('SELECT COUNT(*) as c FROM transactions')[0]?.c || 0;
    if (txnCount >= DEMO_MAX_TXN) return res.status(403).json({ error:'demo_limit', message:`وصلت للحد الأقصى في نسخة الديمو (${DEMO_MAX_TXN} معاملة)` });
    const { clientId, clientName, svcId, svcName, svcType, govFee, officeFee, discount, total, payment, date, status, ref, notes } = req.body;
    const id = run(`INSERT INTO transactions (clientId,clientName,svcId,svcName,svcType,govFee,officeFee,discount,total,payment,date,status,ref,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [clientId, clientName, svcId, svcName, svcType, govFee||0, officeFee||0, discount||0, total||0, payment, date, status||'paid', ref||'', notes||'']);
    res.json({ id, ...req.body });
  });

  app.put('/api/transactions/:id', (req, res) => {
    const { status, notes } = req.body;
    db.run('UPDATE transactions SET status=?, notes=? WHERE id=?', [status, notes||'', req.params.id]);
    saveDB();
    res.json({ ok: true });
  });

  app.delete('/api/transactions/:id', (req, res) => {
    db.run('DELETE FROM transactions WHERE id=?', [req.params.id]);
    saveDB();
    res.json({ ok: true });
  });

  // ── Expenses ─────────────────────────────────────────────────────────────────
  app.get('/api/expenses', (req, res) => {
    res.json(query('SELECT * FROM expenses ORDER BY id DESC'));
  });

  app.post('/api/expenses', (req, res) => {
    const { description, category, amount, date, notes } = req.body;
    const id = run('INSERT INTO expenses (description,category,amount,date,notes) VALUES (?,?,?,?,?)',
      [description, category||'other', amount||0, date||'', notes||'']);
    res.json({ id, ...req.body });
  });

  app.delete('/api/expenses/:id', (req, res) => {
    db.run('DELETE FROM expenses WHERE id=?', [req.params.id]);
    saveDB();
    res.json({ ok: true });
  });

  // ── Backup ──────────────────────────────────────────────────────────────────
  app.get('/api/backup', (req, res) => {
    const data = {
      exported_at: new Date().toISOString(),
      settings: query('SELECT * FROM settings'),
      clients: query('SELECT * FROM clients'),
      services: query('SELECT * FROM services'),
      transactions: query('SELECT * FROM transactions'),
      expenses: query('SELECT * FROM expenses'),
    };
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename="gulf_backup_${date}.json"`);
    res.json(data);
  });

  // ── Auth routes ────────────────────────────────────────────────────────────
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const rows = query('SELECT value FROM settings WHERE key=?', ['auth_users']);
    let users = [];
    if (rows.length) { try { users = JSON.parse(rows[0].value); } catch(e){} }

    // First-time setup: no users yet → accept admin/admin and save
    if (!users.length) {
      if (username === 'admin' && password === 'admin') {
        const token = makeToken();
        sessions.set(token, { username: 'admin', role: 'admin', loginAt: Date.now() });
        return res.json({ ok: true, token, role: 'admin', firstLogin: true });
      }
      return res.status(401).json({ error: 'wrong' });
    }

    const user = users.find(u => u.username === username && u.password === hashPw(password));
    if (!user) return res.status(401).json({ error: 'wrong' });
    const token = makeToken();
    sessions.set(token, { username: user.username, role: user.role, loginAt: Date.now() });
    res.json({ ok: true, token, role: user.role });
  });

  app.get('/api/auth/check', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (token && sessions.has(token)) {
      const s = sessions.get(token);
      return res.json({ ok: true, username: s.username, role: s.role });
    }
    res.status(401).json({ ok: false });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (token) sessions.delete(token);
    res.json({ ok: true });
  });

  app.post('/api/auth/change-password', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (!token || !sessions.has(token)) return res.status(401).json({ error: 'unauthorized' });
    const sess = sessions.get(token);
    const { oldPassword, newPassword } = req.body;
    const rows = query('SELECT value FROM settings WHERE key=?', ['auth_users']);
    let users = [];
    if (rows.length) { try { users = JSON.parse(rows[0].value); } catch(e){} }

    // First-time: create user list
    if (!users.length && sess.username === 'admin' && oldPassword === 'admin') {
      users = [{ username: 'admin', password: hashPw(newPassword), role: 'admin' }];
      db.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', ['auth_users', JSON.stringify(users)]);
      saveDB();
      return res.json({ ok: true });
    }
    const idx = users.findIndex(u => u.username === sess.username && u.password === hashPw(oldPassword));
    if (idx === -1) return res.status(400).json({ error: 'wrong_old' });
    users[idx].password = hashPw(newPassword);
    db.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', ['auth_users', JSON.stringify(users)]);
    saveDB();
    res.json({ ok: true });
  });

  // ── Demo status route ───────────────────────────────────────────────────────
  app.get('/api/demo/status', (req, res) => {
    const start = getDemoStart();
    const diffDays = (Date.now() - start.getTime()) / (1000*60*60*24);
    const daysLeft = Math.max(0, Math.ceil(DEMO_DAYS - diffDays));
    const txnCount = query('SELECT COUNT(*) as c FROM transactions')[0]?.c || 0;
    const clientCount = query('SELECT COUNT(*) as c FROM clients')[0]?.c || 0;
    res.json({
      isDemo: true,
      daysLeft,
      expired: isDemoExpired(),
      txnCount, txnMax: DEMO_MAX_TXN,
      clientCount, clientMax: DEMO_MAX_CLIENTS,
      startDate: start.toISOString()
    });
  });

  // ── Catch-all → serve index.html ────────────────────────────────────────────
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

// ── Start ────────────────────────────────────────────────────────────────────
setupDB().then(() => {
  registerRoutes();
  app.listen(PORT, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    let lanIP = 'YOUR-IP';
    Object.values(interfaces).forEach(list => {
      list && list.forEach(iface => {
        if (iface && iface.family === 'IPv4' && !iface.internal) lanIP = iface.address;
      });
    });

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  🏛  نظام الخليج للخدمات الإدارية - Gulf Admin System  ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  ✅  السيرفر يعمل على المنفذ: ${PORT}                        ║`);
    console.log(`║  🖥   هذا الجهاز:       http://localhost:${PORT}             ║`);
    console.log(`║  🌐  الشبكة الداخلية:   http://${lanIP}:${PORT}         ║`);
    console.log('║                                                          ║');
    console.log('║  افتح المتصفح على أي جهاز في الشبكة واكتب العنوان أعلاه║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
  });
}).catch(err => {
  console.error('❌ فشل تشغيل السيرفر:', err);
  process.exit(1);
});
