CES backend

The primary runtime is a standalone Node 24 HTTP server and SQLite database.
It needs no package installation, third-party SDK, email service, or cloud API.
The same standard Web Request/Response handler can also run with an optional
Worker/D1 adapter. Hosting and HTTPS are separate from this application.

Start
1. Prepare the site's public files in the repository's .site-build directory.
   Never copy backend, private exports, credentials, .git, or node_modules there.
2. Create a dedicated private directory outside the repository, with mode 700.
3. Create config.json there with mode 600. Required settings:
   PUBLIC_ORIGIN           Public HTTPS origin, without a path or trailing slash.
   DATABASE_PATH           Absolute SQLite file path in a private directory.
   ADMIN_EMAIL             Administrator's email address, lower case.
   ADMIN_PASSWORD_SALT     Random 16+ byte salt encoded as base64url.
   ADMIN_PASSWORD_HASH     PBKDF2-SHA256, 100000 iterations, 256 bits, hex.
   SESSION_SECRET          Independent random secret of at least 32 characters.
   RATE_LIMIT_SECRET       Independent random secret of at least 32 characters.
   Optional PORT (8787), BIND_HOST (127.0.0.1), TRUST_PROXY_IPS (exact IPs),
   PUBLIC_ORIGINS (comma-separated additional public signup/contact origins).
4. Put an HTTPS reverse proxy in front of the server. Preserve the external Host.
   List only that proxy's exact address in TRUST_PROXY_IPS. Keep the application
   port private. The server trusts no forwarded IP headers by default.
5. CES_CONFIG_FILE=/absolute/private/config.json node backend/server.mjs

The password is never stored in source or in plaintext in the configuration.
worker.mjs exports derivePassword(password, salt) for setup scripts.
Sessions last 12 hours and use HttpOnly, Secure, SameSite=Strict cookies.
All administrative writes require the session's X-CSRF-Token plus an exact Origin.
There is no email-send function. Contact messages are stored in the board inbox.

Private audience tools
node backend/audience-cli.mjs import --database /private/ces.sqlite --source /private/state.json
node backend/audience-cli.mjs export --database /private/ces.sqlite --output /private/audience.csv --format csv
node backend/audience-cli.mjs export --database /private/ces.sqlite --output /private/audience.json --format json
node backend/audience-cli.mjs export --database /private/ces.sqlite --output /private/migration.json --format migration
node backend/audience-cli.mjs backup --database /private/ces.sqlite --output /private/backup.sqlite
node backend/audience-cli.mjs stats --database /private/ces.sqlite

Imports accept a full legacy {subscribers: {...}} state, {records: [...]}, or a
contact array. Use a fresh full legacy state when moving the live audience:
redacted audience exports do not contain existing private unsubscribe hashes.
Imports retain unsubscribe hashes and preserve the strongest suppression status.
The importer creates a database backup before changing any contacts.
Ordinary exports omit unsubscribe hashes; migration exports preserve them.

Hosted migration
POST /api/admin/import with {records:[...]} uses login + X-CSRF-Token.
Limit: 500 records, 512 KiB per request. On a free Worker query allowance, use
25 records per request. No public import endpoint or private data in source.

Validation
node --test backend/tests/*.test.mjs

Keep the SQLite database and config on persistent storage and back them up.
Public site files are replaceable. Do not expose the database/config in a static
web directory. Source code alone does not provide an always-on public host.
