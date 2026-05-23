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
  VOYAGE_API_KEY,
  VOYAGE_MODEL = 'voyage-3',
} = process.env;

// Shared PG pool (re-use across requests)
const pgPool = ULOS_DB_HOST
  ? new pg.Pool({
      host: ULOS_DB_HOST,
      port: Number(ULOS_DB_PORT || 5432),
      database: ULOS_DB_NAME,
      user: ULOS_DB_USER,
      password: ULOS_DB_PASSWORD,
      max: 5,
      idleTimeoutMillis: 30000,
    })
  : null;

app.set('view engine', 'ejs');
app.set('views', join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: false }));

// Healthcheck — bez auth
app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Basic auth middleware (po /healthz)
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
  if (!pgPool) return { error: 'ULOS_DB_HOST missing', items: [] };
  try {
    const { rows } = await pgPool.query(`
      SELECT relname AS table_name, n_live_tup AS row_count
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY n_live_tup DESC
      LIMIT 20
    `);
    return { items: rows };
  } catch (err) {
    return { error: err.message, items: [] };
  }
}

/** Embedding coverage stats dla knowledge_items */
async function getEmbeddingStats() {
  if (!pgPool) return { error: 'ULOS_DB_HOST missing', items: [] };
  try {
    const { rows } = await pgPool.query(`
      SELECT
        COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
        COUNT(*) FILTER (WHERE embedding IS NULL) AS pending,
        COUNT(*) AS total,
        MAX(embedding_at) AS last_embedded_at,
        MIN(embedding_at) AS first_embedded_at
      FROM knowledge_items
    `);
    const stat = rows[0];
    const total = Number(stat.total);
    const embedded = Number(stat.embedded);
    const pending = Number(stat.pending);
    const coveragePct = total > 0 ? Math.round((embedded / total) * 100) : 0;
    return {
      total,
      embedded,
      pending,
      coveragePct,
      lastEmbeddedAt: stat.last_embedded_at,
      firstEmbeddedAt: stat.first_embedded_at,
    };
  } catch (err) {
    return { error: err.message };
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
  const [coolify, pg, embStats, sqlite, vault] = await Promise.all([
    getCoolifyApps(),
    getPgTables(),
    getEmbeddingStats(),
    getSqliteCounts(),
    getVaultCommits(),
  ]);
  return {
    generated_at: new Date().toISOString(),
    coolify,
    postgres: pg,
    embeddings: embStats,
    sqlite,
    vault,
  };
}

/**
 * Semantic search po knowledge_items via pgvector cosine similarity.
 * Voyage embedding query → PG ORDER BY embedding <=> query LIMIT 20.
 */
async function semanticSearch(query, options = {}) {
  if (!VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY missing');
  if (!pgPool) throw new Error('PG pool not initialized');

  const { brand = null, type = null, limit = 20 } = options;

  // 1. Embed query
  const voyResp = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: [query.slice(0, 28000)],
      model: VOYAGE_MODEL,
      input_type: 'query',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!voyResp.ok) {
    const errBody = await voyResp.text();
    throw new Error(`Voyage query error ${voyResp.status}: ${errBody.slice(0, 300)}`);
  }
  const voyData = await voyResp.json();
  const queryEmbedding = voyData.data[0].embedding;
  const pgVec = '[' + queryEmbedding.join(',') + ']';

  // 2. PG cosine similarity search
  // pgvector <=> = cosine distance (0 = identical, 2 = opposite)
  // similarity = 1 - distance / 2 (0 = opposite, 1 = identical)
  const whereParts = ['embedding IS NOT NULL'];
  const params = [pgVec];
  let paramIdx = 2;
  if (brand) {
    whereParts.push(`brand = $${paramIdx++}`);
    params.push(brand);
  }
  if (type) {
    whereParts.push(`type = $${paramIdx++}`);
    params.push(type);
  }
  params.push(limit);

  const sql = `
    SELECT id, title, summary, brand, type, project, kontrahent, document_date, vault_path,
           1 - (embedding <=> $1::vector) / 2 AS similarity
    FROM knowledge_items
    WHERE ${whereParts.join(' AND ')}
    ORDER BY embedding <=> $1::vector
    LIMIT $${paramIdx}
  `;
  const { rows } = await pgPool.query(sql, params);
  return {
    query,
    model: voyData.model,
    tokensUsed: voyData.usage.total_tokens,
    results: rows.map((r) => ({
      ...r,
      similarity: Number(r.similarity).toFixed(3),
    })),
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

/** Semantic search UI — GET /search?q=...&brand=...&type=... */
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const brand = (req.query.brand || '').toString().trim() || null;
  const type = (req.query.type || '').toString().trim() || null;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  if (!q) {
    return res.render('search', { query: '', brand, type, results: null, error: null, tokensUsed: 0 });
  }
  try {
    const result = await semanticSearch(q, { brand, type, limit });
    res.render('search', {
      query: q,
      brand,
      type,
      results: result.results,
      error: null,
      tokensUsed: result.tokensUsed,
      model: result.model,
    });
  } catch (err) {
    res.render('search', { query: q, brand, type, results: null, error: err.message, tokensUsed: 0 });
  }
});

/** Search API — same logic, JSON output */
app.get('/api/search.json', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const brand = (req.query.brand || '').toString().trim() || null;
  const type = (req.query.type || '').toString().trim() || null;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  if (!q) {
    return res.status(400).json({ error: 'Missing query param ?q=...' });
  }
  try {
    const result = await semanticSearch(q, { brand, type, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`UL OS Status dashboard listening on :${PORT}`);
});
