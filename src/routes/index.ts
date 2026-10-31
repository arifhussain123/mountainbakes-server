import { Express } from 'express';
import { router as authRouter } from './auth.routes';

import { router as usersRouter } from './users.routes';
import { router as branchesRouter } from './branches.routes';
import { router as branchLocationsRouter } from './branch-locations.routes';
import { router as productsRouter } from './products.routes';
import { router as packingMaterialsRouter } from './packing-materials.routes';
import { router as priceRouter } from './price-management.routes';
import { router as customersRouter } from './customers.routes';
import { router as ordersRouter } from './orders.routes';
import { router as productionRouter } from './production.routes';
import { router as productionOrdersRouter } from './production-orders.routes';
import { router as productionStockRouter } from './production-stock.routes';
import { router as productionReturnsRouter } from './production-returns.routes';
import { router as returnStockRouter } from './return-stock.routes';
import { router as productionDiscountsRouter } from './production-discounts.routes';
import { router as branchDiscountsRouter } from './branch-discounts.routes';
import { router as cashTransfersRouter } from './cash-transfers.routes';
import { router as branchAccountRouter } from './branch-account.routes';
import { router as productionReportsRouter } from './production-reports.routes';
import { router as expensesRouter } from './expenses.routes';
import { router as branchClosingRouter } from './branch-closing.routes';
import { router as dailySaleRouter } from './daily-sale.routes';
import { router as stockRouter } from './stock.routes';
import { router as reportsRouter } from './reports.routes';
import { router as salesAnalyticsRouter } from './sales-analytics.routes';
import { router as searchRouter } from './search.routes';
import { router as supportRouter } from './support.routes';
import { router as closingNotificationsRouter } from './closing-notifications.routes';
import { router as specialEventsRouter } from './special-events.routes';
import { router as specialOrdersRouter } from './special-orders.routes';
import { router as settingsRouter } from './settings.routes';
import { router as loginHistoryRouter } from './login-history.routes';
import { router as loginAttemptsRouter } from './login-attempts.routes';
import { router as businessDayRouter } from './business-day.routes';
import { router as financeRouter } from './finance.routes';
import { router as financeIncomeRouter, entriesRouter as financeEntriesRouter } from './finance-income.routes';
import { router as financeAiCaptureRouter } from './finance-ai-capture.routes';
import { router as financePayrollRouter } from './finance-payroll.routes';
import { router as financeLoansRouter } from './finance-loans.routes';
import { router as financePartnersRouter } from './finance-partners.routes';
import { router as financeBranchShareRouter } from './finance-branch-share.routes';
import { router as financeBranchAccountRouter } from './finance-branch-account.routes';
import { router as financeReportsRouter } from './finance-reports.routes';
import { router as financeTicketsRouter } from './finance-tickets.routes';
import { router as financeCashTransfersRouter } from './finance-cash-transfers.routes';
import { router as financeDailySalesRouter } from './finance-daily-sales.routes';
import { router as attachmentsRouter } from './attachments.routes';
import { router as dataRouter } from './data.routes';
import { router as backupsRouter } from './backups.routes';
import { router as restrictionsRouter } from './restrictions.routes';
import { router as notificationsRouter } from './notifications.routes';
import { router as publicBrandingRouter } from './public-branding.routes';
import { router as purchasingRouter } from './purchasing.routes';
import { router as supplierPortalRouter } from './supplier-portal.routes';
import { router as financeSupplierPaymentsRouter } from './finance-supplier-payments.routes';
import { PUBLIC_BRANDING_PATH } from '../services/file-store';

export function setupRoutes(app: Express) {
  app.use('/api/auth', authRouter);

  app.use('/api/users', usersRouter);
  app.use('/api/branches', branchesRouter);
  // Its own prefix rather than a sub-path of /api/branches: the admin module lists
  // and edits geofences as a resource in their own right, and a location is
  // deliberately not part of a branch record (see migration 48).
  app.use('/api/branch-locations', branchLocationsRouter);
  // Register the specific price prefix before the products router so it wins the match.
  app.use('/api/products/price', priceRouter);
  app.use('/api/products', productsRouter);
  // Its own prefix, not a sub-path of products: packing materials are service
  // items with no price, deliberately kept out of the product tables entirely.
  app.use('/api/packing-materials', packingMaterialsRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/production', productionRouter);
  app.use('/api/production-orders', productionOrdersRouter);
  app.use('/api/production-stock', productionStockRouter);
  app.use('/api/production-returns', productionReturnsRouter);
  // Branch Return Stock — a separate inventory from the production pool
  // (migration 139). Never served as part of /api/production-stock.
  app.use('/api/return-stock', returnStockRouter);
  // Discount claims, split across two prefixes the way returns are: the branch
  // raises and corrects on one, Production reviews on the other, and each router
  // carries its own requireRole at the mount instead of re-checking per handler.
  app.use('/api/production-discounts', productionDiscountsRouter);
  app.use('/api/branch-discounts', branchDiscountsRouter);
  // Branch → cash handed to the company (migration 118). Finance's review side
  // is /api/finance/cash-transfers below.
  app.use('/api/cash-transfers', cashTransfersRouter);
  // A branch's own Demand Record, read-only (Finance's is /api/finance/branch-account).
  app.use('/api/branch-account', branchAccountRouter);
  app.use('/api/production-reports', productionReportsRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/branch-closing', branchClosingRouter);
  // Daily Sale Record — the branch's daily reconciliation of system sales against
  // physically counted receipts. Its own prefix rather than a path under
  // /api/branch-closing: that surface writes nothing and locks nothing, while this
  // one is a signed, audited record with a status machine behind it.
  app.use('/api/daily-sale-records', dailySaleRouter);
  app.use('/api/stock', stockRouter);
  app.use('/api/reports', reportsRouter);
  // Daily Sales analytics. Its own prefix, not a path under /api/reports: it
  // aggregates in Postgres (migration 100) rather than in Node, and it is read
  // by a dashboard card that refetches on every filter change.
  app.use('/api/sales-analytics', salesAnalyticsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/support', supportRouter);
  app.use('/api/closing-notifications', closingNotificationsRouter);
  // The in-app notification feed (the bell). Polled by every open tab, which is
  // why app.ts exempts its GET from the app-wide rate limiter.
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/special-events', specialEventsRouter);
  app.use('/api/special-orders', specialOrdersRouter);
  app.use('/api/settings', settingsRouter);
  // The logo, served without a session — the login page and printed receipts
  // have none. Only answers when files are on S3 (FILE_STORAGE_DRIVER=s3).
  app.use(PUBLIC_BRANDING_PATH, publicBrandingRouter);
  // Admin Settings → Restriction Rules (migration 136): the rules, the approval
  // requests that lift one once, the branch monitor and the audit trail, plus
  // the preflight the branch popups call. Enforcement itself lives inside the
  // write routes it guards, not here.
  app.use('/api/restrictions', restrictionsRouter);
  // Login History. Opened and pinged by the client: signing in (/api/auth) only
  // issues the tokens, and the history row is written by the client's own call.
  app.use('/api/login-history', loginHistoryRouter);
  // Its own mount rather than a path under login-history, because its POST is
  // the one unauthenticated write in the API and that router applies
  // `authenticate` to everything. Two postures, two routers — see the header of
  // login-attempts.routes.ts.
  app.use('/api/login-attempts', loginAttemptsRouter);
  app.use('/api/business-day', businessDayRouter);
  // Shared by finance and branch: one upload endpoint for every captured photo,
  // which decides what the caller may attach to from the `entity` field.
  app.use('/api/attachments', attachmentsRouter);
  // Data Engine: one generic list/aggregate/export endpoint per published
  // resource (src/data-engine/registry.ts). The URL names a resource, never
  // a table.
  app.use('/api/data', dataRouter);
  // WhatsApp Purchasing (migration 20261020000002): Production's demands to
  // outside suppliers, and the supplier's own link-only side. The webhook is
  // mounted in app.ts, ahead of the JSON parser.
  app.use('/api/purchasing', purchasingRouter);
  app.use('/api/supplier-portal', supplierPortalRouter);

  // ── Finance Ledger ──
  // PREFIX ORDER MATTERS here exactly as it does for /api/products/price above:
  // Express matches mounts in registration order, and `/api/finance` would
  // swallow every one of the four specific prefixes below if it came first. The
  // symptom would be a 404 from the general router rather than an obvious
  // routing error, so keep the general mount LAST.
  app.use('/api/finance/ai-capture', financeAiCaptureRouter);
  app.use('/api/finance/income/entries', financeEntriesRouter);
  app.use('/api/finance/income', financeIncomeRouter);
  app.use('/api/finance/payroll', financePayrollRouter);
  app.use('/api/finance/partner-expenses', financePartnersRouter);
  app.use('/api/finance/branch-share', financeBranchShareRouter);
  app.use('/api/finance/branch-account', financeBranchAccountRouter);
  app.use('/api/finance/reports', financeReportsRouter);
  app.use('/api/finance/tickets', financeTicketsRouter);
  app.use('/api/finance/cash-transfers', financeCashTransfersRouter);
  app.use('/api/finance/daily-sales', financeDailySalesRouter);
  app.use('/api/finance/supplier-payments', financeSupplierPaymentsRouter);
  app.use('/api/finance/loans', financeLoansRouter);
  app.use('/api/finance', financeRouter);
  // Database backups — super_admin only. Lives under /api/admin/ because it is
  // operations tooling, not a business resource: it reports on pg_dump → S3
  // runs, verifies them and can start one. See docs/database-backup.md.
  app.use('/api/admin/backups', backupsRouter);
}
