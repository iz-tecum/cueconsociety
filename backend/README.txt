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

Optional preparation while the sender alias is still missing or pending:
append --allow-pending-alias true to the helper command. This explicit opt-in
can save the verified mailbox's OAuth credentials with sending still disabled.
It reports oauthConnected:true, connected:false, aliasVerified:false and
connectionPending:sender_verification. The
default remains strict: an unaccepted alias aborts without saving. Wrong account,
missing permissions, malformed responses and Google/API errors always abort,
including in preparation mode. No alias is created and no verification email is
sent. The runtime still checks Google's accepted alias before it can start or
send; saved credentials alone do not establish sender readiness. These result
flags are not stored as authorization claims in the private configuration.

Direct mailbox scopes: openid, email, and gmail.send.
If the sender differs from the mailbox, gmail.settings.basic is additionally
needed to read its existing send-as aliases. That scope can also edit settings;
the application uses it only for the read check. It never silently widens scopes.
The adapter checks userinfo email_verified, the exact principal, OAuth audience,
send permission, and an actual accepted sendAs entry when an alias is used.
A configured boolean is never treated as proof that an alias is verified.

Connection readiness is distinct from delivery. Status reports configuration
present, a recent verified Google connection, and sending enabled separately.
The existing POST /sending/check is a no-send preflight: it reads identity and
alias information, clears old verification first, and never creates or starts
a campaign. A failed check leaves the connection unverified. Successful proof
expires after one hour and is bound to the current private credentials, sender,
principal and unsubscribe configuration. Rotating those values requires another
check. The proof hash stays private in bounded send_control metadata; no schema
change is needed. Status and Check never return credentials or token values.
Each check owns a private attempt nonce, so a newer failed check cannot be
overwritten by an older successful response. The access-token cache is bound
to all three OAuth credentials, including the client secret.

Additional status fields: connectionVerified, verificationExpiresAt (or null),
configurationMissing (missing private field names only), connectionState
(not_configured/check_required/verified), and deliveryTested. deliveryTested is
false: this preflight does not test recipient delivery, spam placement or quota.
available still requires configured, enabled and a current verified connection.
All logged-in Maildesk administrators use the one owner-authorized server-side
mailbox connection; logging in does not independently authorize a Google account.

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

Per-admin Columbia Google connections (hosted or portable)
Set GOOGLE_SESSION_OAUTH_ENABLED="true" to use each CES admin's own Google
mailbox instead of the legacy single-mailbox configuration. The existing CES
login is always required. A Columbia Google login alone cannot create an admin
session. Google must confirm email_verified and an exact @columbia.edu address.
The sender is that verified address, not a form field or the shared CES login.

GOOGLE_CLIENT_ID             Google Web OAuth client ID.
GOOGLE_CLIENT_SECRET         Its private client secret.
GOOGLE_REDIRECT_URI          Exact HTTPS callback on this application's origin.
                            https://admin.cueconsociety.com/api/admin/google/callback
GOOGLE_TOKEN_ENCRYPTION_KEY  32 random bytes encoded as unpadded base64url.
GOOGLE_SESSION_OAUTH_ENABLED Literal "true" selects session-based connections.

Only openid, email and gmail.send are requested. No alias-settings scope is
needed. Keep GMAIL_UNSUBSCRIBE_ORIGIN and GMAIL_UNSUBSCRIBE_SECRET stable and
GMAIL_SEND_ENABLED="false" while preparing/verifying connections. Connecting
never starts, resumes or dispatches a campaign. It leaves that global setting
unchanged. The application budget remains shared across all connected accounts:
default 1000 attempts per rolling 24 hours, at most 20 per minute. These are
application caps, not a guarantee of each mailbox's remaining Google allowance.

POST /api/admin/google/start      {} -> {url}; navigate to the returned Google URL.
GET  /api/admin/google/callback   Fixed callback landing, no token exchange here.
POST /api/admin/google/complete   Callback's same-origin finalization only.
POST /api/admin/google/disconnect {} -> {connected:false}; local session only.
GET  /api/admin/google/status     Current CES session's connection status only.
All POSTs require the existing CES session, exact Origin and CSRF. The callback
landing instead validates a short-lived HttpOnly Secure SameSite=Lax binding
cookie and pending state. Its static script clears the callback URL and finishes
from the same origin, where the original Strict CES cookie is available. The
final POST also requires the original session, binding cookie and one-use state.
PKCE/state expire after ten minutes; newer starts or disconnects supersede older
in-flight completions. A logged-out/expired session cannot finish authorization.

The sending-status response adds oauthRequired, oauthAvailable, oauthConnected
and oauthEmail. oauthRequired is true exactly when session OAuth is enabled;
false explicitly selects the existing legacy CLI configuration. Missing or
unavailable configuration in session mode never falls back to legacy credentials.
Credentials never reach the frontend. Refresh tokens are encrypted with AES-GCM
using fresh nonces and Google subject/client-specific authenticated context.
Each CES session has its own active connection. Readiness proofs and campaigns
are bound to the verified Google subject. Another Google account cannot list,
start, pause or dispatch those campaigns. Existing unowned legacy campaigns are
not available in session mode; stage a fresh copy of the saved draft instead.
The last pre-send reservation also checks that the session is still active and
still linked to that Google subject. Disconnect prevents future dispatches but
cannot recall a message already in flight. It never revokes another session's
Google authorization and makes no external request.

Deployment: schema.sql appends google_connections, google_session_connections,
google_oauth_states (including consumed_at), google_campaign_owners and indexes.
SQLiteStore applies these additive CREATE TABLE/INDEX IF NOT EXISTS statements
on startup. For hosted D1, apply the matching schema-only migration before
deploying the worker; request handlers never run schema changes. Existing
contacts, suppression, drafts, jobs and unsubscribe secrets are preserved.
Test with node --test backend/tests/google-session.test.mjs; all Google calls in
that suite are mocked, including any provider-send endpoint.

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
