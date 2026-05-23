# status-bidbee-pl

UL OS live status dashboard. Microapp Node 20 + Express + EJS.

## Co pokazuje

- **Coolify Apps** — wszystkie 7 aplikacji z UUID, FQDN, status (healthy/unhealthy/unknown)
- **Postgres** — top 20 tabel w `ulos_knowledge` z `pg_stat_user_tables`
- **SQLite (legacy)** — counts wybranych kolekcji w `cms.osadathehive.pl`
- **Vault commits** — ostatnie 10 commitów w `HiveLive_Vault`

Auto-refresh co 60 sekund. Endpoint `/api/status.json` zwraca dane jako JSON.

## Auth

Basic auth na `/`, `/api/*`. Endpoint `/healthz` bez auth (dla Coolify/Docker healthcheck).

## Deploy w Coolify

1. New Resource → Public Repository
2. URL: `https://github.com/OsadaTheHive/status-bidbee-pl`
3. Branch: `main`, Build Pack: Dockerfile
4. Domain: `status.bidbee.pl`
5. ENV (z `.env.example`): wypełnij wszystkie wartości
6. Healthcheck: auto-detect z Dockerfile (path `/healthz`)
7. Deploy

## DNS

W Zenboxie: A record `status.bidbee.pl` → `46.225.237.196`

## Lokalne uruchomienie

```bash
cp .env.example .env
# wypełnij
npm install
npm start
# otwórz http://localhost:3000
```
