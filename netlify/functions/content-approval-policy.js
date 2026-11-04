'use strict';

function latestContentApproval(approvals, projectId) {
  const matching = (Array.isArray(approvals) ? approvals : [])
    .filter(item => item && item.projectId === projectId && item.kind === 'content')
    .slice()
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt || a.updatedAt || a.decidedAt || '') || 0;
      const bTime = Date.parse(b.createdAt || b.updatedAt || b.decidedAt || '') || 0;
      return aTime - bTime || String(a.id || '').localeCompare(String(b.id || ''));
    });
  return matching.length ? matching[matching.length - 1] : null;
}

function hasLatestApprovedContent(approvals, projectId) {
  return latestContentApproval(approvals, projectId)?.status === 'approved';
}

module.exports = { latestContentApproval, hasLatestApprovedContent };
