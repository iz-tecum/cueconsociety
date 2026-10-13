CES backend

The primary runtime is a standalone Node 24 HTTP server and SQLite database.
Core audience and draft functions need no package installation, third-party
SDK, email service, or cloud API. Optional delivery uses the Gmail API.
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
Email delivery is staged and disabled by default. Contact messages are stored
in the board inbox. Nothing sends merely because a draft or campaign is saved.

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

Optional Gmail delivery: not connected or enabled by this implementation
The application includes a custom Gmail API adapter and a persistent queue.
No scheduler is installed. Tests use mocked Google responses only.
This can use an existing authorized Google mailbox without adding a Mailchimp
plan or a per-message service subscription. University OAuth rules, account
sending limits, and institutional approval still apply. It is not an unlimited
or automatically university-approved bulk-mail service.

CUIT documents a club/Group address as a verified send-from alias of LionMail:
https://www.cuit.columbia.edu/email/lionmail
For the full CES audience, use or obtain CUIT's approved Listserv path:
https://www.cuit.columbia.edu/mailing-list-management
Do not treat the address printed on an old campaign as proof that a Google
account currently has permission to send from it.

Private configuration keys
GMAIL_PRINCIPAL           Actual authorized Google mailbox address.
GMAIL_FROM                Desired sender, e.g. the verified club alias.
GMAIL_CLIENT_ID           Real Google OAuth Desktop client ID.
GMAIL_CLIENT_SECRET       Real OAuth client secret.
GMAIL_REFRESH_TOKEN       Real refresh token from the account owner's consent.
GMAIL_UNSUBSCRIBE_ORIGIN  HTTPS origin serving this application; no trailing /.
GMAIL_UNSUBSCRIBE_SECRET  Stable independent random secret, at least 32 chars.
GMAIL_SEND_ENABLED        Must be the literal string "true" to start or dispatch.
                         Keep "false" until connection and a send are approved.
GMAIL_DAILY_BUDGET        Optional rolling 24-hour attempt cap; default 1000.
GMAIL_RATE_PER_MINUTE     Optional pace; default 20, one recipient per message.

The default cap is an application limit, not a prediction of Google quota.
Other mail sent from the same account also consumes its provider quota. Lower
the budget for the account's actual allowance. Known quota rejection pauses the
campaign; a new explicit start is required after the retry time.

Connection helper (run only when the owner is ready to authorize Google)
node backend/google-connect.mjs --config /absolute/private/config.json --client /absolute/private/google-desktop-client.json --principal YOUR-MAILBOX --from YOUR-SENDER
The helper prints Google's consent URL, uses a localhost callback with PKCE and
state, and saves credentials only to the private config. It always leaves
GMAIL_SEND_ENABLED="false". It does not create or verify an alias or send email.

Direct mailbox scopes: openid, email, and gmail.send.
If the sender differs from the mailbox, gmail.settings.basic is additionally
needed to read its existing send-as aliases. That scope can also edit settings;
the application uses it only for the read check. It never silently widens scopes.
The adapter checks userinfo email_verified, the exact principal, OAuth audience,
send permission, and an actual accepted sendAs entry when an alias is used.
A configured boolean is never treated as proof that an alias is verified.

Manual workflow
1. Save the draft and stage a campaign. This freezes the text/recipient selection
   and creates prepared jobs; it makes no Google request and sends nothing.
2. After authorized connection, explicitly Check connection. That reads Google
   identity/alias information only. Status itself makes no external request.
3. Once a specific send is approved, explicitly enable delivery in private
   configuration and Start that campaign. Start verifies identity again but
   does not deliver a message.
4. Explicitly dispatch one job, or use a manually started UI chunk. Every job
   rechecks identity and current subscription status. Pause stops future jobs;
   it cannot recall a message already in flight. There is no background resume.

API (all admin routes require login; POSTs also require Origin and CSRF)
GET  /api/admin/sending/status
POST /api/admin/sending/check                    {}
POST /api/admin/sending/campaigns                {draftId}
GET  /api/admin/sending/campaigns
GET  /api/admin/sending/campaigns/:id
POST /api/admin/sending/campaigns/:id/start      {}
POST /api/admin/sending/campaigns/:id/pause      {}
POST /api/admin/sending/dispatch                 {campaignId}

Dispatch processes at most one recipient. The persistent queue enforces a
global SQL lease, rolling attempt budget, and pacing. Only subscribed contacts
can send; existing opt-outs and bounces remain suppressed. Staging/rendering
does not overwrite legacy unsubscribe tokens. New signed per-contact links
allow a confirmation page and an RFC 8058 POST unsubscribe endpoint. GET never
changes subscription status. Keep the signing secret when moving hosts so old
links keep working.

Duplicate protection has a defined limit: campaign snapshots are deduplicated,
jobs have unique campaign/contact keys, and concurrent claims use a SQL lease.
Gmail does not provide a documented send idempotency key. A timeout, 5xx, missing
delivery receipt, or interrupted in-flight job is marked needs_review and is
never automatically resent. Check Sent manually before resolving uncertainty.
Only a definite rejection is eligible for bounded retry, after manual restart.
Successful Gmail acceptance is recorded by provider message ID; it does not
prove that a recipient opened the message or that every destination delivered it.

Google references
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list
https://developers.google.com/workspace/gmail/api/auth/scopes
