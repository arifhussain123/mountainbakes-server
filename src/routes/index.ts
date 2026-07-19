import { Express } from 'express';
import { router as authRouter } from './auth.routes';

// ─── Firestore → Supabase migration: routers are re-enabled as they are ported ──
//
// Every router below still imports `../config/firebase`, which no longer exists.
// Because the imports here are eager, a single unported module throws at load
// time and takes the whole process down — so they stay commented out and their
// paths 404 until each one is ported.
//
// To re-enable a route: port its Firestore calls to Supabase, then uncomment its
// import AND its app.use() line together.
//
// import { router as usersRouter } from './users.routes';
// import { router as branchesRouter } from './branches.routes';
// import { router as productsRouter } from './products.routes';
// import { router as priceRouter } from './price-management.routes';
// import { router as customersRouter } from './customers.routes';
// import { router as ordersRouter } from './orders.routes';
// import { router as productionRouter } from './production.routes';
// import { router as productionOrdersRouter } from './production-orders.routes';
// import { router as productionStockRouter } from './production-stock.routes';
// import { router as productionReturnsRouter } from './production-returns.routes';
// import { router as productionExpensesRouter } from './production-expenses.routes';
// import { router as productionReportsRouter } from './production-reports.routes';
// import { router as expensesRouter } from './expenses.routes';
// import { router as stockRouter } from './stock.routes';
// import { router as reportsRouter } from './reports.routes';
// import { router as searchRouter } from './search.routes';
// import { router as settingsRouter } from './settings.routes';
// import { router as businessDayRouter } from './business-day.routes';

export function setupRoutes(app: Express) {
  app.use('/api/auth', authRouter);

  // app.use('/api/users', usersRouter);
  // app.use('/api/branches', branchesRouter);
  // Register the specific price prefix before the products router so it wins the match.
  // app.use('/api/products/price', priceRouter);
  // app.use('/api/products', productsRouter);
  // app.use('/api/customers', customersRouter);
  // app.use('/api/orders', ordersRouter);
  // app.use('/api/production', productionRouter);
  // app.use('/api/production-orders', productionOrdersRouter);
  // app.use('/api/production-stock', productionStockRouter);
  // app.use('/api/production-returns', productionReturnsRouter);
  // app.use('/api/production-expenses', productionExpensesRouter);
  // app.use('/api/production-reports', productionReportsRouter);
  // app.use('/api/expenses', expensesRouter);
  // app.use('/api/stock', stockRouter);
  // app.use('/api/reports', reportsRouter);
  // app.use('/api/search', searchRouter);
  // app.use('/api/settings', settingsRouter);
  // app.use('/api/business-day', businessDayRouter);
}
