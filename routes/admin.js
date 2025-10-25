const express = require('express');
const mongoose = require('mongoose');
const { 
    generateBlobSas, 
    BlobSASPermissions, 
    StorageSharedKeyCredential 
} = require('@azure/storage-blob');
const User = require('../models/User');
const Trade = require('../models/Trade');
const { candleOverride, TRADE_PAIRS } = require('../index'); 

// The entire module is now a function that accepts Azure dependencies
module.exports = function({ blobServiceClient, KYC_CONTAINER_NAME, STORAGE_ACCOUNT_NAME, STORAGE_ACCOUNT_KEY }) {
    const router = express.Router();

    // Admin security middleware (remains the same)
    const adminAuth = (req, res, next) => {
        const adminKey = req.headers['x-admin-key'];
        if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
            return res.status(403).json({ success: false, message: "Forbidden: Invalid Admin Key" });
        }
        next();
    };

    router.use(adminAuth);

    // ----------------------------------------------------------------------
    // CORRECTED KYC REVIEW ENDPOINTS
    // ----------------------------------------------------------------------

    // [GET] /api/admin/kyc/pending-users - Get users awaiting KYC review
    router.get('/kyc/pending-users', async (req, res) => {
        if (!blobServiceClient || !STORAGE_ACCOUNT_KEY) {
            return res.status(503).json({ success: false, message: 'Azure Storage not configured for review.' });
        }

        try {
            // Find users who have uploaded documents and are awaiting review
            const usersToReview = await User.find({ kycStatus: 'review' }).select('username kycStatus kycDocuments createdAt');

            const usersWithSignedUrls = await Promise.all(usersToReview.map(async (user) => {

                const getSignedUrl = async (blobPath) => {
                    if (!blobPath) return null;

                    try {
                        const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
                        const blobClient = containerClient.getBlobClient(blobPath);

                        // Generate SAS token - simplified approach
                        const expiresOn = new Date();
                        expiresOn.setHours(expiresOn.getHours() + 1); // 1 hour expiry

                        const sasUrl = await blobClient.generateSasUrl({
                            permissions: BlobSASPermissions.parse("r"),
                            expiresOn: expiresOn
                        });

                        return sasUrl;
                    } catch (error) {
                        console.error(`Error generating SAS URL for ${blobPath}:`, error);
                        return null;
                    }
                };

                const frontUrl = await getSignedUrl(user.kycDocuments?.front);
                const backUrl = await getSignedUrl(user.kycDocuments?.back);

                return {
                    _id: user._id,
                    username: user.username,
                    kycStatus: user.kycStatus,
                    joined: user.createdAt,
                    documents: {
                        front: frontUrl,
                        back: backUrl,
                    }
                };
            }));

            res.json({ success: true, users: usersWithSignedUrls });

        } catch (error) {
            console.error('Admin KYC Fetch Error:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch pending KYC users.' });
        }
    });


    // [POST] /api/admin/kyc/update - Update a user's KYC status
    router.post('/kyc/update', async (req, res) => {
        const { userId, newStatus, reason } = req.body;

        if (!['verified', 'rejected'].includes(newStatus)) {
            return res.status(400).json({ success: false, message: 'Invalid status provided.' });
        }

        try {
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }

            user.kycStatus = newStatus;
            if (newStatus === 'rejected') {
                user.kycRejectionReason = reason || 'Documents did not meet requirements.';
            } else if (newStatus === 'verified') {
                user.kycRejectionReason = undefined;
            }

            await user.save();

            res.json({ success: true, message: `KYC status updated to ${newStatus}.` });

        } catch (error) {
            console.error('Admin KYC Update Error:', error);
            res.status(500).json({ success: false, message: 'Failed to update KYC status.' });
        }
    });

    // ----------------------------------------------------------------------
    // CORRECTED DEPOSIT/WITHDRAWAL ENDPOINTS
    // ----------------------------------------------------------------------

    // GET all admin data
    router.get('/data', async (req, res) => {
        const { search } = req.query;
        try {
            let userQuery = {};
            if (search) {
                userQuery = { username: { $regex: search, $options: 'i' } };
            }

            const users = await User.find(userQuery)
                .select('_id username balance totalDeposits totalTradeVolume referredBy transactions')
                .populate('referredBy', 'username');

            // Calculate total volume by pair and direction
            const tradeVolume = await Trade.aggregate([
                { $match: { status: { $ne: 'closed' } } },
                { 
                    $group: { 
                        _id: { asset: '$asset', direction: '$direction' },
                        totalAmount: { $sum: '$amount' }
                    }
                }
            ]);

            const marketStatus = {};
            TRADE_PAIRS.forEach(pair => {
                marketStatus[pair] = candleOverride[pair];
            });

            res.json({ success: true, users, tradeVolume, marketStatus, tradePairs: TRADE_PAIRS });

        } catch (error) {
            console.error('Admin Data Fetch Error:', error);
            res.status(500).json({ success: false, message: "Server error fetching data." });
        }
    });

    // --- CORRECTED DEPOSIT & WITHDRAWAL MANAGEMENT ---
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

            // FIXED: Use find() to search by txid instead of id()
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
            transaction.amount = amount; // Set the amount definitively on completion

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

            // FIXED: Use find() to search by txid instead of id()
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

            // FIXED: Use find() to search by txid instead of id()
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

            // FIXED: Use find() to search by txid instead of id()
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

    // --- FIXED: MANUAL USER CREDIT ---
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

    // --- FIXED: REFERRAL COMMISSION ---
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

    // --- MARKET CONTROL ---
    router.post('/market-control', (req, res) => {
        const { pair, direction } = req.body;

        if (!pair || (direction !== 'up' && direction !== 'down' && direction !== null)) {
            return res.status(400).json({ success: false, message: "Invalid pair or direction. Direction must be 'up', 'down', or null to disable." });
        }

        if (!TRADE_PAIRS.includes(pair)) {
            return res.status(400).json({ success: false, message: "Invalid trading pair." });
        }

        candleOverride[pair] = direction;

        const message = direction ? `Market control set to ${direction.toUpperCase()} for ${pair}.` : `Market control disabled for ${pair}.`;
        res.json({ success: true, message });
    });

// ----------------------------------------------------------------------
// COPY TRADE MANAGEMENT ROUTES
// ----------------------------------------------------------------------

const AdminCopyTrade = require('../models/AdminCopyTrade');

// [POST] /api/admin/copy-trade/create - Create new copy trade
router.post('/copy-trade/create', async (req, res) => {
    const { tradingPair, direction, percentage, executionTime } = req.body;

    // Validation
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
        // Create the copy trade (admin user ID can be fixed or from session)
        const copyTrade = new AdminCopyTrade({
            tradingPair: tradingPair.toUpperCase(),
            direction: direction.toUpperCase(),
            percentage: parseFloat(percentage),
            executionTime: new Date(executionTime),
            createdBy: req.headers['x-admin-user-id'] || new mongoose.Types.ObjectId() // You can adjust this
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

// [GET] /api/admin/copy-trade/active - Get active copy trades
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

// [GET] /api/admin/copy-trade/history - Get copy trade history
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

// [DELETE] /api/admin/copy-trade/:id - Delete copy trade
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

// [POST] /api/admin/copy-trade/cleanup - Manual cleanup of expired trades
router.post('/copy-trade/cleanup', async (req, res) => {
    try {
        const result = await AdminCopyTrade.cleanupExpiredTrades();

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