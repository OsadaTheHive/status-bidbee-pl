import express from 'express';
import ejs from 'ejs';
import basicAuth from 'basic-auth';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);

const {
  BASIC_AUTH_USER,
  BASIC_AUTH_PASSWORD,
  COOLIFY_URL,
  COOLIFY_API_TOKEN,
  ULOS_DB_HOST,
  ULOS_DB_PORT,
  ULOS_DB_NAME,
  ULOS_DB_USER,
  ULOS_DB_PASSWORD,
  LEGACY_DIRECTUS_URL,
  LEGACY_DIRECTUS_TOKEN,
  GITHUB_TOKEN,
  VAULT_REPO = 'OsadaTheHive/HiveLive_Vault',
} = process.env;

app.set('view engine', 'ejs');
app.set('views', join(__dirname, '..', 'views'));

// Healthcheck — bez auth, dla Coolify/Docker
app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Basic auth middleware
app.use((req, res, next) => {
  const user = basicAuth(req);
  if (!user || user.name !== BASIC_AUTH_USER || user.pass !== BASIC_AUTH_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="UL OS Status"');
    return res.status(401).send('Authentication required.');
  }
  next();
});

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function getCoolifyApps() {
  if (!COOLIFY_URL || !COOLIFY_API_TOKEN) return { error: 'COOLIFY_URL or COOLIFY_API_TOKEN missing', items: [] };
  try {
    const apps = await fetchJson(`${COOLIFY_URL}/api/v1/applications`, {
      headers: { Authorization: `Bearer ${COOLIFY_API_TOKEN}` },
    });
    return {
      items: apps.map(a => ({
        name: a.name,
        uuid: a.uuid,
        status: a.status,
        fqdn: a.fqdn || '',
        last_online_at: a.last_online_at || null,
      })),
    };
  } catch (err) {
    return { error: err.message, items: [] };
  }
}

async function getPgTables() {
  if (!ULOS_DB_HOST) return { error: 'ULOS_DB_HOST missing', items: [] };
  const client = new pg.Client({
    host: ULOS_DB_HOST,
    port: Number(ULOS_DB_PORT || 5432),
    database: ULOS_DB_NAME,
    user: ULOS_DB_USER,
    password: ULOS_DB_PASSWORD,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT relname AS table_name, n_live_tup AS row_count
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY n_live_tup DESC
      LIMIT 20
    `);
    return { items: rows };
  } catch (err) {
    return { error: err.message, items: [] };
  } finally {
    try { await client.end(); } catch {}
  }
}

async function getSqliteCounts() {
  if (!LEGACY_DIRECTUS_URL || !LEGACY_DIRECTUS_TOKEN) {
    return { error: 'LEGACY_DIRECTUS_URL or LEGACY_DIRECTUS_TOKEN missing', items: [] };
  }
  const collections = ['monet_telemetry', 'knowledge_items', 'shipments', 'email_unified', 'modbus_register_map'];
  const results = [];
  for (const c of collections) {
    try {
      const r = await fetchJson(
        `${LEGACY_DIRECTUS_URL}/items/${c}?aggregate[count]=*`,
        { headers: { Authorization: `Bearer ${LEGACY_DIRECTUS_TOKEN}` } }
      );
      const count = r?.data?.[0]?.count ?? r?.data?.[0]?.count_id ?? null;
      results.push({ collection: c, count: count !== null ? Number(count) : 'n/a' });
    } catch (err) {
      results.push({ collection: c, count: 'err', error: err.message });
    }
  }
  return { items: results };
}

async function getVaultCommits() {
  if (!GITHUB_TOKEN) return { error: 'GITHUB_TOKEN missing', items: [] };
  try {
    const commits = await fetchJson(
      `https://api.github.com/repos/${VAULT_REPO}/commits?per_page=10`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    return {
      items: commits.map(c => ({
        sha: c.sha.substring(0, 7),
        message: c.commit.message.split('\n')[0],
        author: c.commit.author.name,
        date: c.commit.author.date,
      })),
    };
  } catch (err) {
    return { error: err.message, items: [] };
  }
}

async function buildStatus() {
  const [coolify, pg, sqlite, vault] = await Promise.all([
    getCoolifyApps(),
    getPgTables(),
    getSqliteCounts(),
    getVaultCommits(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    coolify,
    postgres: pg,
    sqlite,
    vault,
  };
}

app.get('/', async (req, res) => {
  const status = await buildStatus();
  res.render('dashboard', { status });
});

app.get('/api/status.json', async (req, res) => {
  const status = await buildStatus();
  res.json(status);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`UL OS Status dashboard listening on :${PORT}`);
});
