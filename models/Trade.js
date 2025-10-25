const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    direction: { // 'UP' or 'DOWN'
        type: String,
        required: true
    },
    asset: { // e.g., 'BTCUSDT'
        type: String,
        required: true
    },
    status: { // 'pending', 'scheduled', 'active', 'closed', 'cancelled'
        type: String,
        required: true,
        index: true
    },
    timestamp: { // When the trade was created
        type: Date,
        default: Date.now
    },
    scheduledTime: { // For scheduled trades
        type: Date,
        index: true
    },
    activationTimestamp: { // When the trade became active (compatibility field)
        type: Date 
    },
    entryPrice: {
        type: Number
    },
    exitPrice: {
        type: Number
    },
    closeTime: { // <-- ***** THE CRITICAL FIX *****
        type: Date,
        index: true // Add index for fast P&L queries
    },
    result: { // 'WIN', 'LOSS', 'TIE'
        type: String
    },
    pnl: {
        type: Number
    },
    isCopyTrade: {
        type: Boolean,
        default: false
    },
    originalCopyTradeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AdminCopyTrade'
    }
});

// Compound index for finding user's trades
tradeSchema.index({ userId: 1, status: 1 });
// Compound index for finding active trades to settle
tradeSchema.index({ status: 1, asset: 1 });

const Trade = mongoose.model('Trade', tradeSchema);

module.exports = Trade;