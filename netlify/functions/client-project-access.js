'use strict';

function projectBelongsToAccount(project, account, lead = null) {
  if (!project || !account) return false;
  const ids = [account.id, account.clientId].filter(Boolean);
  const accountEmail = String(account.email || '').trim().toLowerCase();
  const emails = [project.email, project.clientEmail, lead?.email]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);

  return ids.includes(project.clientId)
    || ids.includes(project.accountId)
    || Boolean(lead && ids.includes(lead.clientId))
    || Boolean(accountEmail && emails.includes(accountEmail));
}

module.exports = { projectBelongsToAccount };
