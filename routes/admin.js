const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Trade = require('../models/Trade');
const AdminCopyTrade = require('../models/AdminCopyTrade');
const { generateBlobSas, BlobSASPermissions } = require('@azure/storage-blob');

const TRADE_PAIRS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','MATICUSDT'
];

module.exports = function({ blobServiceClient, KYC_CONTAINER_NAME, azureEnabled = false, candleOverride = {} }) {
    const router = express.Router();

    // Admin security middleware
    const adminAuth = (req, res, next) => {
        const adminKey = req.headers['x-admin-key'];
        if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
            return res.status(403).json({ success: false, message: "Forbidden: Invalid Admin Key" });
        }
        next();
    };

    router.use(adminAuth);

    // ----------------------------------------------------------------------
    // COMPLETE ADMIN DATA ENDPOINT
    // ----------------------------------------------------------------------

    router.get('/data', async (req, res) => {
        const { search } = req.query;
        try {
            let userQuery = {};
            if (search && search.trim() !== '') {
                userQuery = { username: { $regex: search.trim(), $options: 'i' } };
            }

            const users = await User.find(userQuery)
                .select('_id username balance totalDeposits totalTradeVolume referredBy transactions createdAt kycStatus')
                .populate('referredBy', 'username')
                .lean();

            // Calculate total volume by pair and direction
            const tradeVolume = await Trade.aggregate([
                { $match: { status: { $in: ['pending', 'active', 'scheduled'] } } },
                { 
                    $group: { 
                        _id: { asset: '$asset', direction: '$direction' },
                        totalAmount: { $sum: '$amount' }
                    }
                }
            ]);

            // Calculate pending deposits and withdrawals with amounts
            const usersWithPending = await Promise.all(users.map(async (user) => {
                const pendingDeposits = user.transactions?.filter(tx => 
                    tx.type === 'deposit' && tx.status === 'pending_review'
                ) || [];

                const pendingWithdrawals = user.transactions?.filter(tx => 
                    tx.type === 'withdrawal' && tx.status === 'pending_processing'
                ) || [];

                return {
                    ...user,
                    pendingDeposits: pendingDeposits.length,
                    pendingWithdrawals: pendingWithdrawals.length,
                    pendingDepositsTotal: pendingDeposits.reduce((sum, tx) => sum + (tx.amount || 0), 0),
                    pendingWithdrawalsTotal: pendingWithdrawals.reduce((sum, tx) => sum + (tx.amount || 0), 0),
                    pendingDepositTransactions: pendingDeposits,
                    pendingWithdrawalTransactions: pendingWithdrawals
                };
            }));

            const marketStatus = {};
            TRADE_PAIRS.forEach(pair => {
                marketStatus[pair] = candleOverride[pair] || 'auto';
            });

            res.json({ 
                success: true, 
                users: usersWithPending, 
                tradeVolume, 
                marketStatus, 
                tradePairs: TRADE_PAIRS 
            });

        } catch (error) {
            console.error('Admin Data Fetch Error:', error);
            res.status(500).json({ success: false, message: "Server error fetching data." });
        }
    });

    // ----------------------------------------------------------------------
    // COMPLETE KYC MANAGEMENT
    // ----------------------------------------------------------------------

    router.get('/kyc/pending-users', async (req, res) => {
        try {
            const usersToReview = await User.find({ 
                $or: [
                    { kycStatus: 'review' },
                    { kycStatus: 'under_review' }
                ]
            }).select('username kycStatus kycDocuments kycRejectionReason createdAt');

            const usersWithInfo = usersToReview.map(user => ({
                _id: user._id,
                username: user.username,
                kycStatus: user.kycStatus,
                rejectionReason: user.kycRejectionReason,
                joined: user.createdAt,
                documents: {
                    // ⭐ FIXED: Only indicate if documents exist, the client will call the new route
                    front: !!user.kycDocuments?.front,
                    back: !!user.kycDocuments?.back,
                    uploadDate: user.kycDocuments?.uploadDate,
                    hasDocuments: !!(user.kycDocuments?.front && user.kycDocuments?.back),
                }
            }));

            res.json({ 
                success: true, 
                users: usersWithInfo,
                count: usersWithInfo.length
            });

        } catch (error) {
            console.error('Admin KYC Fetch Error:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch KYC users.' });
        }
    });
    
    // ⭐ NEW ROUTE: SECURELY SERVE KYC DOCUMENTS
    router.get('/kyc/document/:userId/:side', async (req, res) => {
        const { userId, side } = req.params;

        if (!['front', 'back'].includes(side)) {
            return res.status(400).send('Invalid document side.');
        }
        
        if (!blobServiceClient || !KYC_CONTAINER_NAME || !azureEnabled) {
            return res.status(503).send('Azure Storage is not configured or available.');
        }

        try {
            const user = await User.findById(userId).select('kycDocuments');
            if (!user) {
                return res.status(404).send('User not found.');
            }

            const blobName = user.kycDocuments?.[side];

            if (!blobName) {
                return res.status(404).send(`No ${side} document found for this user.`);
            }

            // Generate a temporary Shared Access Signature (SAS) URL
            const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
            const blobClient = containerClient.getBlobClient(blobName);

            // Generate SAS URL valid for 30 minutes for reading the blob
            const sasToken = generateBlobSas(blobName, containerClient.containerName, {
                containerClient,
                startsOn: new Date(),
                expiresOn: new Date(new Date().valueOf() + (30 * 60 * 1000)), // 30 mins
                permissions: BlobSASPermissions.parse("r"), // Read permission
            });
            
            const sasUrl = `${blobClient.url}?${sasToken}`;
            
            // Redirect the admin to the secure, temporary blob URL
            return res.redirect(sasUrl);

        } catch (error) {
            console.error(`Admin KYC Document View Error (${side}):`, error);
            return res.status(500).send('Server failed to retrieve the document.');
        }
    });
    // ⭐ END NEW ROUTE

    router.post('/kyc/update', async (req, res) => {
        const { userId, newStatus, reason } = req.body;

        if (!['verified', 'rejected', 'approved', 'declined'].includes(newStatus)) {
            return res.status(400).json({ success: false, message: 'Invalid status provided.' });
        }

        try {
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }

            // Map status to consistent format
            const statusMap = {
                'verified': 'verified',
                'approved': 'verified', 
                'rejected': 'rejected',
                'declined': 'rejected'
            };

            user.kycStatus = statusMap[newStatus];
            if (statusMap[newStatus] === 'rejected') {
                user.kycRejectionReason = reason || 'Documents did not meet requirements.';
            } else {
                user.kycRejectionReason = undefined;
            }

            await user.save();

            res.json({ 
                success: true, 
                message: `KYC status updated to ${user.kycStatus}.`,
                newStatus: user.kycStatus
            });

        } catch (error) {
            console.error('Admin KYC Update Error:', error);
            res.status(500).json({ success: false, message: 'Failed to update KYC status.' });
        }
    });

    // ----------------------------------------------------------------------
    // COMPLETE DEPOSIT & WITHDRAWAL MANAGEMENT (No changes needed)
    // ----------------------------------------------------------------------

    router.post('/approve-deposit', async (req, res) => {
        const { userId, txid, amount } = req.body;
        if (!userId || !txid || typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ success: false, message: "Missing required fields or invalid amount." });
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const user = await User.findById(userId).session(session);
            if (!user) {
                await session.abortTransaction();
                session.endSession();
                return res.status(404).json({ success: false, message: "User not found." });
            }

            const transaction = user.transactions.find(tx => 
                tx.txid === txid && 
                tx.status === 'pending_review' && 
                tx.type === 'deposit'
            );

            if (!transaction) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ 
                    success: false, 
                    message: "Invalid or already processed deposit transaction." 
                });
            }

            // Update user's balance and totalDeposits
            user.balance += amount;
            user.totalDeposits += amount;

            // Update transaction status
            transaction.status = 'completed';
            transaction.processedAt = new Date();
            transaction.amount = amount;

            await user.save({ session });
            await session.commitTransaction();
            session.endSession();

            res.json({ success: true, message: `Deposit of $${amount.toFixed(2)} approved for ${user.username}.` });

        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            console.error('Deposit Approval Error:', error);
            res.status(500).json({ success: false, message: "Deposit approval failed due to a server error." });
        }
    });

    router.post('/reject-deposit', async (req, res) => {
        const { userId, txid } = req.body;
        if (!userId || !txid) {
            return res.status(400).json({ success: false, message: "Missing required fields." });
        }

        try {
            const user = await User.findById(userId);
            if (!user) return res.status(404).json({ success: false, message: "User not found." });

            const transaction = user.transactions.find(tx => 
                tx.txid === txid && 
                tx.status === 'pending_review' && 
                tx.type === 'deposit'
            );

            if (!transaction) {
                return res.status(400).json({ 
                    success: false, 
                    message: "Invalid or already processed deposit transaction." 
                });
            }

            transaction.status = 'rejected';
            transaction.processedAt = new Date();

            await user.save();
            res.json({ success: true, message: `Deposit rejected for ${user.username}.` });

        } catch (error) {
            console.error('Deposit Rejection Error:', error);
            res.status(500).json({ success: false, message: "Deposit rejection failed due to a server error." });
        }
    });

    router.post('/approve-withdrawal', async (req, res) => {
        const { userId, txid } = req.body;
        if (!userId || !txid) {
            return res.status(400).json({ success: false, message: "Missing required fields." });
        }

        try {
            const user = await User.findById(userId);
            if (!user) return res.status(404).json({ success: false, message: "User not found." });

            const transaction = user.transactions.find(tx => 
                tx.txid === txid && 
                tx.status === 'pending_processing' && 
                tx.type === 'withdrawal'
            );

            if (!transaction) {
                return res.status(400).json({ 
                    success: false, 
                    message: "Invalid or already processed withdrawal transaction." 
                });
            }

            // NOTE: The balance was already deducted on user's request.
            transaction.status = 'completed';
            transaction.processedAt = new Date();

            await user.save();
            res.json({ success: true, message: `Withdrawal of $${transaction.amount.toFixed(2)} approved for ${user.username}.` });

        } catch (error) {
            console.error('Withdrawal Approval Error:', error);
            res.status(500).json({ success: false, message: "Withdrawal approval failed due to a server error." });
        }
    });

    router.post('/reject-withdrawal', async (req, res) => {
        const { userId, txid } = req.body;
        if (!userId || !txid) {
            return res.status(400).json({ success: false, message: "Missing required fields." });
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const user = await User.findById(userId).session(session);
            if (!user) {
                await session.abortTransaction();
                session.endSession();
                return res.status(404).json({ success: false, message: "User not found." });
            }

            const transaction = user.transactions.find(tx => 
                tx.txid === txid && 
                tx.status === 'pending_processing' && 
                tx.type === 'withdrawal'
            );

            if (!transaction) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ 
                    success: false, 
                    message: "Invalid or already processed withdrawal transaction." 
                });
            }

            // Refund the user's balance
            user.balance += transaction.amount;

            // Update transaction status
            transaction.status = 'rejected';
            transaction.processedAt = new Date();

            await user.save({ session });
            await session.commitTransaction();
            session.endSession();

            res.json({ success: true, message: `Withdrawal of $${transaction.amount.toFixed(2)} rejected and funds refunded to ${user.username}.` });

        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            console.error('Withdrawal Rejection Error:', error);
            res.status(500).json({ success: false, message: "Withdrawal rejection failed due to a server error." });
        }
    });

    // ----------------------------------------------------------------------
    // COMPLETE MANUAL USER CREDIT (No changes needed)
    // ----------------------------------------------------------------------

    router.post('/credit-user', async (req, res) => {
        const { username, amount } = req.body;
        const creditAmount = parseFloat(amount);

        if (!username || isNaN(creditAmount) || creditAmount === 0) {
            return res.status(400).json({ success: false, message: "Invalid username or amount." });
        }

        try {
            const user = await User.findOne({ username });
            if (!user) {
                return res.status(404).json({ success: false, message: "User not found." });
            }

            user.balance += creditAmount;

            // Add transaction record with proper schema
            const transactionData = {
                txid: `ADMIN-${Date.now()}`,
                type: creditAmount > 0 ? 'manual_credit' : 'manual_debit',
                amount: Math.abs(creditAmount),
                status: 'completed',
                date: new Date(),
                note: `Admin adjustment of ${creditAmount > 0 ? '+' : ''}${creditAmount.toFixed(2)}`
            };

            user.transactions.push(transactionData);
            await user.save();

            res.json({ 
                success: true, 
                message: `Balance for ${username} adjusted by ${creditAmount.toFixed(2)}. New balance: ${user.balance.toFixed(2)}` 
            });

        } catch (error) {
            console.error('Manual Credit Error:', error);
            res.status(500).json({ success: false, message: "Failed to adjust user balance." });
        }
    });

    // ----------------------------------------------------------------------
    // COMPLETE REFERRAL COMMISSION (No changes needed)
    // ----------------------------------------------------------------------

    router.post('/give-commission', async (req, res) => {
        const { username, amount } = req.body;
        const commissionAmount = parseFloat(amount);

        if (!username || isNaN(commissionAmount) || commissionAmount <= 0) {
            return res.status(400).json({ success: false, message: "Invalid username or amount." });
        }

        try {
            const user = await User.findOne({ username });
            if (!user) {
                return res.status(404).json({ success: false, message: "User not found." });
            }

            user.balance += commissionAmount;
            user.referralCommissions += commissionAmount;

            // Add transaction record with proper schema
            const transactionData = {
                txid: `COMM-${Date.now()}`,
                type: 'commission',
                amount: commissionAmount,
                status: 'completed',
                date: new Date(),
                note: `Referral commission awarded by admin.`
            };

            user.transactions.push(transactionData);
            await user.save();

            res.json({ 
                success: true, 
                message: `Commission of $${commissionAmount.toFixed(2)} awarded to ${username}. New balance: ${user.balance.toFixed(2)}` 
            });

        } catch (error) {
            console.error('Commission Error:', error);
            res.status(500).json({ success: false, message: "Failed to award commission." });
        }
    });

    // ----------------------------------------------------------------------
    // COMPLETE MARKET CONTROL (No changes needed)
    // ----------------------------------------------------------------------

    router.post('/market-control', (req, res) => {
        const { pair, direction } = req.body;

        // NOTE: The client passes 'up' or 'down'. If it passes 'auto' or 'null', it should be null.
        const effectiveDirection = direction === 'up' || direction === 'down' ? direction : null;


        if (!pair || (direction !== 'up' && direction !== 'down' && direction !== null)) {
            return res.status(400).json({ success: false, message: "Invalid pair or direction. Direction must be 'up', 'down', or null to disable." });
        }

        if (!TRADE_PAIRS.includes(pair)) {
            return res.status(400).json({ success: false, message: "Invalid trading pair." });
        }

        candleOverride[pair] = effectiveDirection; // Update the global state

        const message = effectiveDirection ? `Market control set to ${effectiveDirection.toUpperCase()} for ${pair}.` : `Market control disabled for ${pair}.`;
        res.json({ success: true, message });
    });

    router.get('/market-control/status', (req, res) => {
        const status = {};
        TRADE_PAIRS.forEach(pair => {
            // Read from the global state object
            status[pair] = candleOverride[pair] || 'auto'; 
        });

        res.json({
            success: true,
            marketStatus: status
        });
    });

    // ----------------------------------------------------------------------
    // COMPLETE COPY TRADE MANAGEMENT (No changes needed)
    // ----------------------------------------------------------------------
    
    router.post('/copy-trade/create', async (req, res) => {
        const { tradingPair, direction, percentage, executionTime } = req.body;

        if (!tradingPair || !direction || !percentage || !executionTime) {
            return res.status(400).json({ 
                success: false, 
                message: "Missing required fields: tradingPair, direction, percentage, executionTime" 
            });
        }

        if (!['CALL', 'PUT'].includes(direction.toUpperCase())) {
            return res.status(400).json({ 
                success: false, 
                message: "Direction must be either 'CALL' or 'PUT'" 
            });
        }

        if (percentage < 1 || percentage > 100) {
            return res.status(400).json({ 
                success: false, 
                message: "Percentage must be between 1 and 100" 
            });
        }

        try {
            const copyTrade = new AdminCopyTrade({
                tradingPair: tradingPair.toUpperCase(),
                direction: direction.toUpperCase(),
                percentage: parseFloat(percentage),
                executionTime: new Date(executionTime),
                createdBy: req.headers['x-admin-user-id'] || new mongoose.Types.ObjectId()
            });

            await copyTrade.save();

            res.json({ 
                success: true, 
                message: "Copy trade created successfully",
                copyTrade: {
                    id: copyTrade._id,
                    tradingPair: copyTrade.tradingPair,
                    direction: copyTrade.direction,
                    percentage: copyTrade.percentage,
                    executionTime: copyTrade.executionTime
                }
            });

        } catch (error) {
            console.error('Copy Trade Creation Error:', error);
            res.status(500).json({ 
                success: false, 
                message: "Failed to create copy trade" 
            });
        }
    });

    router.get('/copy-trade/active', async (req, res) => {
        try {
            const activeTrades = await AdminCopyTrade.find({ 
                status: 'active',
                executionTime: { $gt: new Date() }
            })
            .populate('createdBy', 'username')
            .populate('userCopies.userId', 'username')
            .sort({ executionTime: 1 });

            res.json({ 
                success: true, 
                copyTrades: activeTrades 
            });

        } catch (error) {
            console.error('Active Copy Trades Fetch Error:', error);
            res.status(500).json({ 
                success: false, 
                message: "Failed to fetch active copy trades" 
            });
        }
    });

    router.get('/copy-trade/history', async (req, res) => {
        try {
            const { page = 1, limit = 20 } = req.query;

            const history = await AdminCopyTrade.find()
                .populate('createdBy', 'username')
                .populate('userCopies.userId', 'username')
                .sort({ createdAt: -1 })
                .limit(limit * 1)
                .skip((page - 1) * limit);

            const total = await AdminCopyTrade.countDocuments();

            res.json({ 
                success: true, 
                history,
                totalPages: Math.ceil(total / limit),
                currentPage: page
            });

        } catch (error) {
            console.error('Copy Trade History Fetch Error:', error);
            res.status(500).json({ 
                success: false, 
                message: "Failed to fetch copy trade history" 
            });
        }
    });

    router.delete('/copy-trade/:id', async (req, res) => {
        try {
            const { id } = req.params;

            const deletedTrade = await AdminCopyTrade.findByIdAndDelete(id);

            if (!deletedTrade) {
                return res.status(404).json({ 
                    success: false, 
                    message: "Copy trade not found" 
                });
            }

            res.json({ 
                success: true, 
                message: "Copy trade deleted successfully" 
            });

        } catch (error) {
            console.error('Copy Trade Deletion Error:', error);
            res.status(500).json({ 
                success: false, 
                message: "Failed to delete copy trade" 
            });
        }
    });

    router.post('/copy-trade/cleanup', async (req, res) => {
        try {
            const now = new Date();
            const result = await AdminCopyTrade.updateMany(
                { 
                    status: 'active',
                    executionTime: { $lte: now }
                },
                { 
                    $set: { status: 'executed' }
                }
            );

            res.json({ 
                success: true, 
                message: `Cleaned up ${result.modifiedCount} expired copy trades` 
            });

        } catch (error) {
            console.error('Copy Trade Cleanup Error:', error);
            res.status(500).json({ 
                success: false, 
                message: "Failed to cleanup expired copy trades" 
            });
        }
    });

    return router;
};
