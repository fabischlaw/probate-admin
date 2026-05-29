'use strict';

const requireAuth = (req, res, next) => {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!roles.includes(req.session.user.role)) {
    return res.status(403).json({
      error: 'Insufficient permissions',
      required: roles,
      current: req.session.user.role,
    });
  }
  next();
};

const ROLE_PERMISSIONS = {
  attorney: {
    canGenerateForms: true,
    canGenerateAllLetters: true,
    canCompleteAnyTask: true,
    canAdvanceStages: true,
    canChangeMatterType: true,
    canViewFinancials: true,
    canViewAuditLog: true,
    canManageUsers: true,
    canManageAISettings: true,
    canManageFirmProfile: true,
    canRunAgents: true,
    canAssignTasks: true,
    canResolveFlags: true,
    canViewAllMatters: true,
  },
  firm_admin: {
    canGenerateForms: true,
    canGenerateAllLetters: true,
    canCompleteAnyTask: true,
    canAdvanceStages: true,
    canChangeMatterType: true,
    canViewFinancials: true,
    canViewAuditLog: true,
    canManageUsers: true,
    canManageAISettings: true,
    canManageFirmProfile: true,
    canRunAgents: true,
    canAssignTasks: true,
    canResolveFlags: false,
    canViewAllMatters: true,
  },
  paralegal: {
    canGenerateForms: true,
    canGenerateAllLetters: true,
    canCompleteAnyTask: true,
    canAdvanceStages: true,
    canChangeMatterType: false,
    canViewFinancials: true,
    canViewAuditLog: false,
    canManageUsers: false,
    canManageAISettings: false,
    canManageFirmProfile: false,
    canRunAgents: false,
    canAssignTasks: true,
    canResolveFlags: false,
    canViewAllMatters: true,
  },
  va: {
    canGenerateForms: false,
    canGenerateLetters: true,
    canGenerateFinancialLetters: false,
    canCompleteAssignedTasks: true,
    canCompleteAnyTask: false,
    canAdvanceStages: false,
    canChangeMatterType: false,
    canViewFinancials: false,
    canViewAuditLog: false,
    canManageUsers: false,
    canManageAISettings: false,
    canManageFirmProfile: false,
    canRunAgents: false,
    canAssignTasks: false,
    canResolveFlags: false,
    canViewAllMatters: true,
  },
};

// Letters VAs cannot generate (contain financial info)
const VA_BLOCKED_LETTERS = [
  'asset_inquiry',
  'distribution',
  'closing',
  'letter_trust_accounting',
  'letter_trust_termination',
];

module.exports = {
  requireAuth,
  requireRole,
  ROLE_PERMISSIONS,
  VA_BLOCKED_LETTERS,
};
