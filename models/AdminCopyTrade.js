const mongoose = require('mongoose');

const copyTradeSchema = new mongoose.Schema({
    tradingPair: {
        type: String,
        required: true,
        trim: true
    },
    direction: {
        type: String,
        required: true,
        enum: ['CALL', 'PUT'],
        uppercase: true
    },
    percentage: {
        type: Number,
        required: true,
        min: 1,
        max: 100
    },
    executionTime: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'expired', 'executed'],
        default: 'active'
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    userCopies: [{
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        copiedAt: {
            type: Date,
            default: Date.now
        },
        tradeAmount: {
            type: Number,
            required: true
        },
        originalTradeId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Trade'
        }
    }]
}, {
    timestamps: true
});

// Index for efficient querying
copyTradeSchema.index({ executionTime: 1, status: 1 });
copyTradeSchema.index({ status: 1 });

// Static method to cleanup expired trades
copyTradeSchema.statics.cleanupExpiredTrades = async function() {
    try {
        const result = await this.updateMany(
            { 
                executionTime: { $lt: new Date() },
                status: 'active'
            },
            { 
                status: 'expired' 
            }
        );
        console.log(`Cleaned up ${result.modifiedCount} expired copy trades`);
        return result;
    } catch (error) {
        console.error('Error cleaning up expired copy trades:', error);
        throw error;
    }
};

module.exports = mongoose.model('AdminCopyTrade', copyTradeSchema);