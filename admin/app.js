'use strict';
if (window.CES_MAILDESK_CONFIG?.redirectUrl) {
  window.location.replace(window.CES_MAILDESK_CONFIG.redirectUrl);
} else {
const M = window.Maildesk;
const $ = id => document.getElementById(id);
const configuredBase = String(window.CES_MAILDESK_CONFIG?.apiBase || '').replace(/\/$/, '');
const apiBase = configuredBase ? new URL(configuredBase, location.origin).origin : location.origin;
let csrfToken = '', rows = [], drafts = [], selected = new Set(), page = 1;
let audienceTime = '', draftId = '', dirty = false, prepared = false, busy = false, sessionEpoch = 0;
let messages = [], messagesLoaded = false, selectedMessageId = '';
const pageSize = 50;
const number = value => Number(value).toLocaleString();
const statusLabel = value => value === 'cleaned' ? 'Undeliverable' : value[0].toUpperCase() + value.slice(1);

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
}
function hideExports() { prepared = false; $('exports').hidden = true; }
function markDirty() { dirty = true; hideExports(); $('draftState').textContent = 'Unsaved changes'; }
function setBusy(value) {
  busy = value;
  for (const id of ['reload', 'saveDraft', 'pause', 'unsubscribe', 'prepare', 'newDraft', 'draftList', 'subject', 'preheader', 'body', 'selectMatching', 'clearSelection']) $(id).disabled = value;
  for (const checkbox of $('contacts').querySelectorAll('input[type=checkbox]')) checkbox.disabled = value || checkbox.dataset.suppressed === 'true';
  if (!value) updateSelection();
}
function showLogin(message = '') {
  sessionEpoch++;
  csrfToken = ''; rows = []; drafts = []; selected.clear(); draftId = ''; dirty = false;
  messages = []; messagesLoaded = false; selectedMessageId = '';
  $('loginPanel').hidden = false; $('workspace').hidden = true; $('account').hidden = true;
  $('accountEmail').textContent = ''; $('loginPassword').value = ''; $('loginNotice').textContent = message;
  $('contacts').replaceChildren(); $('draftList').replaceChildren();
  $('messageList').replaceChildren(); $('messageDetail').replaceChildren();
  for (const id of ['subject', 'preheader', 'body']) $(id).value = '';
  $('preview').srcdoc = ''; hideExports();
}
async function api(path, { method = 'GET', body } = {}) {
  const epoch = sessionEpoch;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let response;
  try {
    response = await fetch(apiBase + path, { method, headers, credentials: 'include', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Error('Cannot reach Maildesk. Check your connection and try again.');
  }
  if (epoch !== sessionEpoch) throw Error('The session changed. Please sign in again.');
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401 && path !== '/api/admin/login') {
    showLogin('Please sign in to continue.');
    throw Error('Your session ended. Sign in again.');
  }
  if (!response.ok) {
    const error = Error(response.status === 429 ? 'Too many requests. Wait a moment and try again.' : (typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : 'The request failed. Please try again.'));
    error.status = response.status;
    throw error;
  }
  return data;
}
function ask(title, message, okay = 'Continue') {
  return new Promise(resolve => {
    $('confirmTitle').textContent = title; $('confirmText').textContent = message; $('confirmOkay').textContent = okay;
    const dialog = $('confirmDialog');
    function done(value) {
      dialog.close(); $('confirmOkay').onclick = null; $('confirmCancel').onclick = null; dialog.oncancel = null; resolve(value);
    }
    $('confirmOkay').onclick = () => done(true); $('confirmCancel').onclick = () => done(false);
    dialog.oncancel = event => { event.preventDefault(); done(false); }; dialog.showModal();
  });
}
function options(id, values, first) {
  const previous = $(id).value; $(id).replaceChildren();
  for (const value of ['', ...values]) {
    const option = document.createElement('option'); option.value = value; option.textContent = value || first; $(id).append(option);
  }
  if (values.includes(previous)) $(id).value = previous;
}
function filtered() { return M.filter(rows, { search: $('search').value, status: $('status').value, interest: $('interest').value, source: $('source').value }); }
function recipients() { return rows.filter(row => row.status === 'subscribed' && selected.has(row.id)); }
function updateSelection() {
  const count = recipients().length;
  $('selectedCount').textContent = number(count) + ' recipients selected';
  $('campaignAudience').textContent = count ? number(count) + ' subscribers selected' : 'Select subscribers in Audience.';
  $('pause').disabled = $('unsubscribe').disabled = busy || !count;
}
function render() {
  const counts = M.counts(rows);
  for (const status of ['total', 'subscribed', 'unsubscribed', 'cleaned']) $('count-' + status).textContent = number(counts[status]);
  $('count-other').textContent = number(counts.pending + counts.archived);
  const matches = filtered(), pages = Math.max(1, Math.ceil(matches.length / pageSize));
  page = Math.min(page, pages);
  $('matchCount').textContent = number(matches.length) + ' contacts';
  $('pageLabel').textContent = 'Page ' + page + ' of ' + pages;
  $('previous').disabled = page === 1; $('next').disabled = page === pages; $('contacts').replaceChildren();
  for (const row of matches.slice((page - 1) * pageSize, page * pageSize)) {
    const tr = document.createElement('tr'), pick = document.createElement('td'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = selected.has(row.id) && row.status === 'subscribed';
    checkbox.dataset.suppressed = String(row.status !== 'subscribed'); checkbox.disabled = busy || row.status !== 'subscribed'; checkbox.setAttribute('aria-label', 'Select ' + (row.name || row.email));
    checkbox.onchange = () => { checkbox.checked ? selected.add(row.id) : selected.delete(row.id); markDirty(); updateSelection(); }; pick.append(checkbox);
    const contact = document.createElement('td'), name = document.createElement('strong'); contact.className = 'contact'; name.textContent = row.name || row.email; contact.append(name);
    if (row.name) { const email = document.createElement('span'); email.textContent = row.email; contact.append(email); }
    const status = document.createElement('td'), pill = document.createElement('span'); pill.className = 'pill ' + row.status; pill.textContent = statusLabel(row.status); status.append(pill);
    const interests = document.createElement('td'); interests.textContent = row.interests.join(', ') || '—';
    const source = document.createElement('td'); source.className = 'source-cell'; source.textContent = row.sources.join(', ') || '—';
    tr.append(pick, contact, status, interests, source); $('contacts').append(tr);
  }
  if (!matches.length) {
    const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 5; td.className = 'empty'; td.textContent = rows.length ? 'No matching contacts.' : 'No contacts yet.'; tr.append(td); $('contacts').append(tr);
  }
  updateSelection();
}
function draft() { return { title: $('subject').value.trim() || 'Untitled draft', subject: $('subject').value.trim(), preheader: $('preheader').value.trim(), body: $('body').value.trim(), recipientIds: recipients().map(row => row.id) }; }
function preview() { const current = draft(); $('preview').srcdoc = M.campaignHTML(current); $('wordCount').textContent = number(current.body ? current.body.split(/\s+/).length : 0) + ' words'; }
function download(name, content, type = 'application/json') {
  const blob = new Blob([typeof content === 'string' ? content : JSON.stringify(content, null, 2)], { type });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
async function loadAudience() {
  const data = await api('/api/admin/audience');
  if (!Array.isArray(data.records)) throw Error('Maildesk returned an invalid audience. Please refresh.');
  const ids = new Map(data.records.filter(row => row && row.email && row.id != null).map(row => [String(row.email).trim().toLowerCase(), String(row.id)]));
  const normalized = M.normalize(data.records);
  if (normalized.rejected || normalized.duplicates || normalized.rows.some(row => !ids.has(row.email))) throw Error('The audience needs review before it can be edited.');
  rows = normalized.rows.map(row => ({ ...row, id: ids.get(row.email) }));
  selected = new Set(recipients().map(row => row.id)); audienceTime = data.updatedAt || new Date().toISOString();
  const time = new Date(audienceTime); $('snapshot').textContent = 'Updated ' + (Number.isNaN(time.getTime()) ? 'just now' : time.toLocaleString());
  options('interest', [...new Set(rows.flatMap(row => row.interests))].sort(), 'All interests');
  options('source', [...new Set(rows.flatMap(row => row.sources))].sort(), 'All sources'); hideExports(); render();
}
function renderDraftList() {
  $('draftList').replaceChildren(); const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Saved drafts'; $('draftList').append(placeholder);
  for (const current of drafts) { const option = document.createElement('option'); option.value = String(current.id); option.textContent = current.title || current.subject || 'Untitled draft'; $('draftList').append(option); }
  $('draftList').value = draftId;
}
async function loadDrafts() { const data = await api('/api/admin/drafts'); drafts = Array.isArray(data.drafts) ? data.drafts : []; renderDraftList(); }
async function enterSession(session) {
  if (!session?.email || !session?.csrfToken) throw Error('Could not open a secure session. Try signing in again.');
  csrfToken = session.csrfToken; $('loginPassword').value = ''; $('accountEmail').textContent = session.email;
  $('loginPanel').hidden = true; $('workspace').hidden = false; $('account').hidden = false; $('notice').hidden = true; setBusy(true);
  try {
    await loadAudience();
    try { await loadDrafts(); } catch (error) { notice('Audience loaded. Drafts could not be loaded. ' + error.message, true); }
    preview();
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}
function switchPanel(which) {
  for (const [panel, tab, name] of [['audiencePanel', 'tabAudience', 'audience'], ['campaignPanel', 'tabCampaign', 'campaign'], ['inboxPanel', 'tabInbox', 'inbox']]) {
    const active = which === name; $(panel).hidden = !active; $(tab).classList.toggle('selected', active); $(tab).setAttribute('aria-pressed', String(active));
  }
  if (which === 'campaign') preview();
  if (which === 'inbox' && !messagesLoaded) loadMessages();
}
function showMessage(id) {
  const message = messages.find(item => String(item.id) === id); if (!message) return;
  selectedMessageId = id; $('messageDetail').replaceChildren();
  const subject = document.createElement('h2'); subject.textContent = message.subject || 'Contact request';
  const from = document.createElement('p'); from.className = 'message-meta'; from.textContent = [message.name, message.email].filter(Boolean).join(' · ');
  const date = document.createElement('p'); date.className = 'message-meta'; date.textContent = new Date(message.createdAt).toLocaleString();
  const body = document.createElement('p'); body.className = 'message-body'; body.textContent = message.message || '';
  $('messageDetail').append(subject, from, date, body);
  for (const button of $('messageList').children) button.classList.toggle('selected', button.dataset.messageId === id);
}
function renderMessages() {
  $('messageList').replaceChildren();
  for (const message of messages) {
    const button = document.createElement('button'); button.className = 'message-item'; button.dataset.messageId = String(message.id);
    const name = document.createElement('strong'); name.textContent = message.name || message.email || 'Contact request';
    const subject = document.createElement('span'); subject.textContent = message.subject || String(message.message || '').slice(0, 90);
    const time = document.createElement('small'); time.textContent = new Date(message.createdAt).toLocaleString();
    button.append(name, subject, time); button.onclick = () => showMessage(String(message.id)); $('messageList').append(button);
  }
  if (!messages.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No messages yet.'; $('messageList').append(empty); }
  if (messages.some(item => String(item.id) === selectedMessageId)) showMessage(selectedMessageId);
  else if (messages.length) showMessage(String(messages[0].id));
}
async function loadMessages() {
  $('reloadMessages').disabled = true;
  try { const data = await api('/api/admin/messages'); messages = Array.isArray(data.messages) ? data.messages : []; messagesLoaded = true; renderMessages(); }
  catch (error) { notice(error.message, true); }
  finally { $('reloadMessages').disabled = false; }
}
async function refresh() {
  if (busy) return; setBusy(true);
  try { await loadAudience(); await loadDrafts(); notice('Up to date.'); } catch (error) { notice(error.message, true); } finally { setBusy(false); }
}
async function changeStatus(status) {
  if (busy) return;
  const chosen = recipients(); if (!chosen.length) return;
  const verb = status === 'archived' ? 'Archive' : 'Unsubscribe';
  if (!await ask(verb + ' ' + number(chosen.length) + ' contacts?', 'This updates the shared list and excludes these contacts from future campaigns.', verb)) return;
  setBusy(true); hideExports();
  try {
    try { await api('/api/admin/contacts/status', { method: 'POST', body: { ids: chosen.map(row => row.id), status } }); }
    catch (error) {
      if (error.status !== 404) throw error;
      let index = 0, completed = 0, failure = null;
      async function worker() {
        while (index < chosen.length && !failure) {
          const row = chosen[index++];
          try { await api('/api/admin/contacts/' + encodeURIComponent(row.id), { method: 'PATCH', body: { status } }); completed++; notice('Updating ' + completed + ' of ' + chosen.length + '…'); }
          catch (error) { failure = error; }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, chosen.length) }, worker));
      if (failure) throw Error(completed + ' contacts updated. ' + failure.message);
    }
    selected.clear(); dirty = true; await loadAudience(); notice(number(chosen.length) + ' contacts ' + (status === 'archived' ? 'archived.' : 'unsubscribed.'));
  } catch (error) {
    notice(error.message, true);
    if (csrfToken) { try { await loadAudience(); } catch {} }
  } finally { setBusy(false); }
}
async function saveDraft() {
  if (busy) return; const current = draft();
  if (!current.subject && !current.body) return notice('Add a subject or message first.', true);
  setBusy(true);
  try {
    const data = await api('/api/admin/drafts', { method: 'POST', body: { ...current, ...(draftId ? { id: draftId } : {}) } });
    const saved = data.draft || data;
    if (!saved.id) throw Error('The server did not confirm the saved draft. Refresh before trying again.');
    draftId = String(saved.id); dirty = false; $('draftState').textContent = 'Saved';
    await loadDrafts(); notice('Draft saved.');
  } catch (error) { notice(error.message, true); } finally { setBusy(false); }
}
async function chooseDraft(id) {
  if (busy) return;
  if (dirty && !await ask('Open another draft?', 'Unsaved changes will be replaced.', 'Open')) { $('draftList').value = draftId; return; }
  const current = drafts.find(item => String(item.id) === id); if (!current) return;
  draftId = id; const allowed = new Set(Array.isArray(current.recipientIds) ? current.recipientIds.map(String) : []);
  selected = new Set(rows.filter(row => row.status === 'subscribed' && allowed.has(row.id)).map(row => row.id));
  for (const field of ['subject', 'preheader', 'body']) $(field).value = typeof current[field] === 'string' ? current[field] : '';
  dirty = false; hideExports(); $('draftState').textContent = 'Saved'; render(); switchPanel('campaign');
}
async function newDraft() {
  if (busy || (dirty && !await ask('Start a new draft?', 'Unsaved changes will be replaced.', 'New draft'))) return;
  draftId = ''; for (const field of ['subject', 'preheader', 'body']) $(field).value = '';
  dirty = false; hideExports(); $('draftState').textContent = 'Unsaved draft'; renderDraftList(); preview();
}
function ensurePrepared() {
  if (!prepared) { notice('Prepare exports after making changes.', true); return false; }
  if (!recipients().length) { notice('Select at least one subscriber.', true); return false; }
  return true;
}
async function prepare() {
  if (busy) return;
  const current = draft(); if (!current.subject || !current.body) return notice('Add a subject and message first.', true);
  setBusy(true);
  try {
    await loadAudience();
    if (!recipients().length) return notice('Select at least one subscriber.', true);
    prepared = true; $('exportSummary').textContent = number(recipients().length) + ' current subscribers. Nothing sent.'; $('exports').hidden = false; notice('Exports ready.');
  } catch (error) { notice(error.message, true); } finally { setBusy(false); }
}
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginButton').disabled = true; $('loginNotice').textContent = 'Signing in…';
  const email = $('loginEmail').value.trim(), password = $('loginPassword').value;
  try {
    const result = await api('/api/admin/login', { method: 'POST', body: { email, password } });
    $('loginPassword').value = ''; await enterSession(result.email && result.csrfToken ? result : await api('/api/admin/session'));
  } catch (error) { $('loginPassword').value = ''; $('loginNotice').textContent = error.status === 401 ? 'Email or password is incorrect.' : error.message; }
  finally { $('loginButton').disabled = false; }
});
$('logout').onclick = async () => {
  if (dirty && !await ask('Log out?', 'Unsaved draft changes will be lost.', 'Log out')) return;
  try { await api('/api/admin/logout', { method: 'POST', body: {} }); showLogin(); }
  catch (error) { notice('Could not log out. ' + error.message, true); }
};
$('reload').onclick = refresh; $('tabAudience').onclick = () => switchPanel('audience'); $('tabCampaign').onclick = () => switchPanel('campaign');
$('tabInbox').onclick = () => switchPanel('inbox'); $('reloadMessages').onclick = loadMessages;
for (const id of ['search', 'status', 'interest', 'source']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { page = 1; render(); });
$('selectMatching').onclick = () => { for (const row of filtered()) if (row.status === 'subscribed') selected.add(row.id); markDirty(); render(); };
$('clearSelection').onclick = () => { selected.clear(); markDirty(); render(); };
$('previous').onclick = () => { page--; render(); }; $('next').onclick = () => { page++; render(); };
$('pause').onclick = () => changeStatus('archived'); $('unsubscribe').onclick = () => changeStatus('unsubscribed');
$('exportAllJSON').onclick = () => { if (rows.length) download('CES_Audience_' + stamp() + '.json', { schema: 'ces-maildesk-audience-v1', exportedAt: new Date().toISOString(), updatedAt: audienceTime, records: rows }); };
$('exportAllCSV').onclick = () => { if (rows.length) download('CES_Audience_' + stamp() + '.csv', M.safeCSV(rows), 'text/csv;charset=utf-8'); };
for (const id of ['subject', 'preheader', 'body']) $(id).addEventListener('input', () => { markDirty(); preview(); });
$('saveDraft').onclick = saveDraft; $('newDraft').onclick = newDraft; $('draftList').onchange = () => chooseDraft($('draftList').value); $('prepare').onclick = prepare;
$('exportHTML').onclick = () => { if (ensurePrepared()) download('CES_Email_' + stamp() + '.html', M.campaignHTML(draft()), 'text/html;charset=utf-8'); };
$('exportText').onclick = () => { if (ensurePrepared()) download('CES_Email_' + stamp() + '.txt', M.plainText(draft()), 'text/plain;charset=utf-8'); };
$('exportRecipientsCSV').onclick = () => { if (ensurePrepared()) download('CES_Recipients_' + stamp() + '.csv', M.safeCSV(recipients()), 'text/csv;charset=utf-8'); };
$('exportRecipientsJSON').onclick = () => { if (ensurePrepared()) download('CES_Recipients_' + stamp() + '.json', recipients()); };
$('exportPackage').onclick = () => { if (ensurePrepared()) download('CES_Campaign_' + stamp() + '.json', { schema: 'ces-maildesk-campaign-v1', preparedAt: new Date().toISOString(), audienceUpdatedAt: audienceTime, ...draft(), html: M.campaignHTML(draft()), text: M.plainText(draft()), recipients: recipients(), delivery: 'Not sent. Add individual unsubscribe links and refresh statuses before sending.' }); };
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
(async () => {
  $('loginButton').disabled = true; $('loginNotice').textContent = 'Checking session…';
  try { await enterSession(await api('/api/admin/session')); }
  catch (error) { showLogin(error.status === 401 || !csrfToken && error.message === 'Your session ended. Sign in again.' ? '' : error.message); }
  finally { $('loginButton').disabled = false; }
})();
}
