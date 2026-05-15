import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import plaidRoutes from './routes/plaid.js';
import transactionsRoutes from './routes/transactions.js';
import masterListsRoutes from './routes/masterLists.js';
import settingsRoutes from './routes/settings.js';
import recurringBillsRoutes from './routes/recurringBills.js';
import historyRoutes from './routes/history.js';
import rulesRoutes from './routes/rules.js';
import closeoutRoutes from './routes/closeout.js';
import backupRoutes from './routes/backup.js';
import accountsRoutes from './routes/accounts.js';
import dataHealthRoutes from './routes/dataHealth.js';
import reportsRoutes from './routes/reports.js';
import budgetBucketsRoutes from './routes/budgetBuckets.js';
import debtSnowballRoutes from './routes/debtSnowball.js';
import transfersRoutes from './routes/transfers.js';
import cashFlowRoutes from './routes/cashFlow.js';

const app = express();
const PORT = parseInt(process.env.BACKEND_PORT || '8787', 10);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

app.use('/api/plaid', plaidRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/master-lists', masterListsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/rules', rulesRoutes);
app.use('/api/recurring-bills', recurringBillsRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/closeout', closeoutRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/data-health', dataHealthRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/budget-buckets', budgetBucketsRoutes);
app.use('/api/debt-snowball', debtSnowballRoutes);
app.use('/api/transfers', transfersRoutes);
app.use('/api/cash-flow', cashFlowRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Closeout payload is too large. Save compact summary only.' });
  }
  return next(err);
});

app.listen(PORT, () => {
  console.log(`Budget dashboard backend running on http://localhost:${PORT}`);
});
