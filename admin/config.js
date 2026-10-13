'use strict';
const publicWebsiteHosts = new Set(['cueconsociety.com', 'www.cueconsociety.com', 'iz-tecum.github.io']);
const useHostedMaildesk = publicWebsiteHosts.has(location.hostname) || location.hostname.endsWith('.vercel.app');
window.CES_MAILDESK_CONFIG = Object.freeze({
  apiBase: '',
  redirectUrl: useHostedMaildesk ? 'https://admin.cueconsociety.com/admin/' : ''
});
