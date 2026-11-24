const mongoose = require('mongoose');

const stockHistorySchema = new mongoose.Schema({
  productId: { type: String, required: true },
  branchId: { type: String, required: true },
  variationId: { type: String, default: '' },
  variationName: { type: String, default: '' },
  previousQuantity: { type: Number, required: true },
  quantity: { type: Number, required: true },
  reason: { type: String, required: true },
  staffId: { type: String, default: '' }
}, { timestamps: true });

stockHistorySchema.index({ productId: 1, createdAt: -1, _id: -1 });
stockHistorySchema.index({ productId: 1, branchId: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model('ProductStockHistory', stockHistorySchema);
