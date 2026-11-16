const mongoose = require('mongoose');
const SB = require('../Model');
const Tx = require('../../AccountTransaction/Model');
const Profit = require('../../SureBankAccount/Model');
const Wallet = require('../../Account/Model');
const Request = require('../../CustomerWithdrawalRequest/Model');

exports.list = async (number) => {
  const account = await SB.findOne({ SBAccountNumber: number });
  if (!account || account.items?.length || account.accountMode === 'multi_item') throw new Error('Legacy SB package not found');
  const sales = await Tx.find({ accountTypeId: String(account._id), direction: 'Purchased', package: 'SB' }).sort({ createdAt: -1 }).lean();
  const reversals = await Tx.find({ accountTypeId: String(account._id), transactionRef: /^LEGACY_SALE_REVERSAL_/ }).lean();
  return sales.filter(sale => !reversals.some(r => r.transactionRef === `LEGACY_SALE_REVERSAL_${sale._id}`));
};

exports.reverse = async (saleId, adminId, reason) => {
  if (!String(reason || '').trim()) throw new Error('A reversal reason is required');
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const sale = await Tx.findById(saleId).session(session);
      if (!sale || sale.package !== 'SB' || sale.direction !== 'Purchased') throw new Error('Legacy sale not found');
      const account = await SB.findById(sale.accountTypeId).session(session);
      if (!account || account.items?.length || account.accountMode === 'multi_item') throw new Error('Only legacy SB sales can be reversed');
      const ref = `LEGACY_SALE_REVERSAL_${sale._id}`;
      if (await Tx.exists({ transactionRef: ref }).session(session)) throw new Error('Sale already reversed');
      // Older records lack sale IDs. Require an unambiguous, tightly bounded match.
      const next = await Tx.findOne({ accountTypeId: sale.accountTypeId, direction: 'Purchased', createdAt: { $gt: sale.createdAt } }).sort({ createdAt: 1 }).session(session);
      const upper = new Date(Math.min(new Date(sale.createdAt).getTime() + 60000, next ? new Date(next.createdAt).getTime() : Infinity));
      const window = { $gte: sale.createdAt, $lt: upper };
      const profits = await Profit.find({ type: String(account._id), direction: 'Credit', package: 'SB', createdAt: window }).session(session);
      if (profits.length !== 1) throw new Error('Cannot safely identify the original profit; manual review required');
      const transfers = await Tx.find({ accountTypeId: String(account._id), direction: 'Debit', narration: `Excess SB balance transferred to wallet from ${account.SBAccountNumber}`, createdAt: window }).session(session);
      const moved = await Tx.find({ accountTypeId: String(account._id), direction: 'Moved', narration: 'Excess legacy SB balance moved to Free To Withdraw', createdAt: window }).session(session);
      if (transfers.length + moved.length > 1) throw new Error('Ambiguous excess transfer; manual review required');
      const excess = Number((transfers[0] || moved[0])?.amount || 0);
      const wallet = await Wallet.findOne({ customerId: account.customerId, $or: [{ walletType: 'free_to_withdraw' }, { walletType: { $exists: false } }] }).session(session);
      if (!wallet) throw new Error('Free To Withdraw wallet not found');
      const pending = await Request.find({ customerId: account.customerId, status: { $in: ['Pending','pending','Processing','processing'] }, $or: [{ accountTypeId: String(wallet._id) }, { payoutAccountId: String(wallet._id) }] }).session(session);
      const reserved = pending.reduce((n,r) => n + Number(r.amount || 0), 0);
      if (excess > Math.max(0, Number(wallet.availableBalance || 0) - reserved)) throw new Error('Transferred excess is spent or reserved; replenish Free To Withdraw before reversing');
      const amount = Number(sale.amount);
      const audit = { createdBy: adminId, transactionOwnerId: adminId, customerId: account.customerId, branchId: account.branchId, accountManagerId: account.accountManagerId, date: new Date().toISOString(), excludeFromStaffStats: true, transactionRef: ref };
      const records = [{ ...audit, accountNumber: account.accountNumber, accountTypeId: account._id, package: 'SB', direction: 'Reversal', amount: amount + excess, balance: Number(account.balance || 0) + amount + excess, narration: `Reversed sale ${sale._id}: ${reason}` }];
      if (excess) records.push({ ...audit, accountNumber: wallet.accountNumber, accountTypeId: wallet._id, package: 'Wallet', direction: 'Debit', amount: excess, balance: Number(wallet.availableBalance) - excess, narration: `Recovered excess for reversed sale ${sale._id}: ${reason}` });
      await Tx.create(records, { session, ordered: true });
      await Wallet.updateOne({ _id: wallet._id }, { $inc: { ledgerBalance: amount, availableBalance: -excess } }, { session });
      await Profit.create([{ type: account._id, package: 'SB', direction: 'Debit', date: audit.date, narration: `Reversed profit ${profits[0]._id} for sale ${sale._id}: ${reason}`, branchId: account.branchId, customerId: account.customerId, amount: profits[0].amount }], { session, ordered: true });
      await require('../Model/order').updateMany({ SBAccountNumber: account.SBAccountNumber, status: { $in: ['Sold', 'sold'] }, createdAt: window }, { $set: { status: 'Reversed', editedBy: adminId } }, { session });
      account.balance = Number(account.balance || 0) + amount + excess;
      account.status = 'booked'; account.costPrice = 0; account.profit = 0; account.editedBy = adminId;
      await account.save({ session });
    });
    return { message: 'Sale and profit reversed; funds restored to SB package' };
  } finally { await session.endSession(); }
};
