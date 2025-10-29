const express = require('express');
const mongoose = require('mongoose');
const { 
    BlobSASPermissions,
    StorageSharedKeyCredential, 
    ContainerClient,
    BlobClient
} = require('@azure/storage-blob');

const User = require('../models/User');
const Trade = require('../models/Trade');
const AdminCopyTrade = require('../models/AdminCopyTrade');
// Rely on index.js to provide these global constants
const { candleOverride, TRADE_PAIRS } = require('../index'); 

// The entire module is now a function that accepts Azure dependencies
module.exports = function({ blobServiceClient, KYC_CONTAINER_NAME, azureEnabled = false, STORAGE_ACCOUNT_NAME, STORAGE_ACCOUNT_KEY }) {
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
    // [GET] /api/admin/data - General Admin Dashboard Data (Unchanged)
    // ----------------------------------------------------------------------
    router.get('/data', async (req, res) => {
        const { search } = req.query;
        try {
            let userQuery = {};
            if (search) {
                userQuery = { username: { $regex: search, $options: 'i' } };
            }

            const users = await User.find(userQuery)
                .select('_id username balance totalDeposits totalTradeVolume referredBy transactions createdAt kycStatus')
                .populate('referredBy', 'username');

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
            
            const marketStatus = {};
            TRADE_PAIRS.forEach(pair => {
                marketStatus[pair] = candleOverride[pair] || 'auto'; 
            });
            
            // Calculate pending deposits and withdrawals with amounts
            const usersWithPending = await Promise.all(users.map(async (user) => {
                const pendingDeposits = user.transactions?.filter(tx => 
                    tx.type === 'deposit' && tx.status === 'pending_review'
                ) || [];

                const pendingWithdrawals = user.transactions?.filter(tx => 
                    tx.type === 'withdrawal' && tx.status === 'pending_processing'
                ) || [];

                return {
                    ...user.toObject(), 
                    pendingDeposits: pendingDeposits.length,
                    pendingWithdrawals: pendingWithdrawals.length,
                    pendingDepositsTotal: pendingDeposits.reduce((sum, tx) => sum + (tx.amount || 0), 0),
                    pendingWithdrawalsTotal: pendingWithdrawals.reduce((sum, tx) => sum + (tx.amount || 0), 0),
                    pendingDepositTransactions: pendingDeposits,
                    pendingWithdrawalTransactions: pendingWithdrawals
                };
            }));


            res.json({ success: true, users: usersWithPending, tradeVolume, marketStatus, tradePairs: TRADE_PAIRS });

        } catch (error) {
            console.error('Admin Data Fetch Error:', error);
            res.status(500).json({ success: false, message: "Server error fetching data." });
        }
    });

    // ----------------------------------------------------------------------
    // KYC MANAGEMENT ENDPOINTS (Unchanged)
    // ----------------------------------------------------------------------

    // [GET] /api/admin/kyc/pending-users - Get users awaiting KYC review
    router.get('/kyc/pending-users', async (req, res) => {
        if (!blobServiceClient || !KYC_CONTAINER_NAME || !azureEnabled) {
            return res.status(200).json({ success: false, message: 'Azure Storage not configured for KYC review. Cannot fetch documents.' });
        }

        try {
            // ⭐ FIX 1: Select new identity fields and the selfie document path
            const usersToReview = await User.find({ 
                $or: [
                    { kycStatus: 'review' },
                    { kycStatus: 'under_review' }
                ]
            }).select('username kycStatus kycDocuments fullName identityNumber createdAt');

            const usersWithUrls = await Promise.all(usersToReview.map(async (user) => {

                // Helper to generate secure SAS URLs
                const getSignedUrl = async (blobPath) => {
                    if (!blobPath || !STORAGE_ACCOUNT_NAME || !STORAGE_ACCOUNT_KEY) return null;

                    try {
                        // 1. Create credential using the raw key passed from index.js
                        const sharedKeyCredential = new StorageSharedKeyCredential(
                            STORAGE_ACCOUNT_NAME,
                            STORAGE_ACCOUNT_KEY
                        );
                        
                        // 2. Create BlobClient using the raw key
                        const blobClient = new BlobClient(
                             `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${KYC_CONTAINER_NAME}/${blobPath}`,
                            sharedKeyCredential
                        );

                        // 3. Define Start/Expiry Times with Clock Skew Buffer
                        const startTime = new Date();
                        startTime.setMinutes(startTime.getMinutes() - 5); // CRITICAL: 5 minutes buffer into the past
                        
                        const expiresOn = new Date();
                        expiresOn.setMinutes(expiresOn.getMinutes() + 30); // Valid for 30 minutes

                        // 4. Generate SAS token using the BlobClient method (stable and reliable)
                        const sasToken = await blobClient.generateSasUrl({
                            permissions: BlobSASPermissions.parse("r"), // Read permission
                            startsOn: startTime, 
                            expiresOn: expiresOn,
                        });
                        
                        // FIX: generateSasUrl returns the full URL with the SAS token appended
                        return sasToken; 

                    } catch (error) {
                        console.error(`Error generating SAS URL for ${blobPath}:`, error.message);
                        return null; 
                    }
                };

                const frontUrl = await getSignedUrl(user.kycDocuments?.front);
                const backUrl = await getSignedUrl(user.kycDocuments?.back);
                const selfieUrl = await getSignedUrl(user.kycDocuments?.selfie);

                return {
                    _id: user._id,
                    username: user.username,
                    kycStatus: user.kycStatus,
                    joined: user.createdAt,
                    fullName: user.fullName,
                    identityNumber: user.identityNumber,
                    documents: {
                        front: frontUrl, 
                        back: backUrl,
                        selfie: selfieUrl,
                    }
                };
            }));

            // Filter out users who somehow got status 'review' without documents
            res.json({ success: true, users: usersWithUrls.filter(u => u.documents.front || u.documents.back || u.documents.selfie) });

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
    // DEPOSIT/WITHDRAWAL MANAGEMENT ENDPOINTS
    // ----------------------------------------------------------------------

    // [POST] /api/admin/approve-deposit - *** UPDATED FOR REFERRAL COMMISSION ***
    router.post('/approve-deposit', async (req, res) => {
        const { userId, txid, amount } = req.body;
        if (!userId || !txid || typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ success: false, message: "Missing required fields or invalid amount." });
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            // Find user and include referredBy field for commission check
            const user = await User.findById(userId)
                .select('username balance totalDeposits transactions referredBy') // Select necessary fields
                .session(session);

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
            
            // --- 1. REFERRAL COMMISSION CHECK ---
            // Determine if the deposit makes totalDeposits non-zero, indicating it's the first deposit.
            const isFirstDeposit = (user.totalDeposits || 0) === 0; 
            const depositAmount = amount;

            // --- 2. UPDATE USER AND TRANSACTION ---
            user.balance += depositAmount;
            user.totalDeposits += depositAmount;

            transaction.status = 'completed';
            transaction.processedAt = new Date();
            transaction.amount = depositAmount;

            await user.save({ session }); // Save user's deposit update

            // --- 3. AWARD COMMISSION (If conditions met) ---
            if (isFirstDeposit && user.referredBy) {
                const commissionRate = 0.07; // 7% commission
                const commissionAmount = depositAmount * commissionRate;
                const referrerId = user.referredBy;

                // Atomically update referrer's account within the same transaction session
                await User.findByIdAndUpdate(referrerId, {
                    $inc: { 
                        balance: commissionAmount,
                        referralCommissions: commissionAmount 
                    },
                    $push: { // Add a transaction record to the referrer's account
                        transactions: {
                            txid: `REFCOMM-${txid}`, // Unique ID based on original transaction
                            type: 'commission',
                            amount: commissionAmount,
                            status: 'completed',
                            date: new Date(),
                            note: `Referral commission for ${user.username}'s first deposit.`
                        }
                    }
                }, { session, new: true }); // Pass the session and return the updated doc (though not used here)

                console.log(`AWARDED: $${commissionAmount.toFixed(2)} (7%) commission to referrer ID: ${referrerId} for a $${depositAmount.toFixed(2)} deposit.`);
            }

            await session.commitTransaction();
            session.endSession();

            res.json({ success: true, message: `Deposit of $${amount.toFixed(2)} approved for ${user.username}. Commission awarded to referrer if applicable.` });

        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            console.error('Deposit Approval Error (Referral Commission Failed):', error);
            res.status(500).json({ success: false, message: "Deposit approval failed due to a server error. Funds rolled back." });
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
    // MANUAL USER CREDIT (Unchanged)
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
    // REFERRAL COMMISSION (Manual) - UNCHANGED
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
    // MARKET CONTROL (Unchanged)
    // ----------------------------------------------------------------------

    router.post('/market-control', (req, res) => {
        const { pair, direction } = req.body;

        if (!pair || (direction !== 'up' && direction !== 'down' && direction !== null)) {
            return res.status(400).json({ success: false, message: "Invalid pair or direction. Direction must be 'up', 'down', or null to disable." });
        }

        if (!TRADE_PAIRS.includes(pair)) {
            return res.status(400).json({ success: false, message: "Invalid trading pair." });
        }

        candleOverride[pair] = direction; // Update the global state

        const message = direction ? `Market control set to ${direction.toUpperCase()} for ${pair}.` : `Market control disabled for ${pair}.`;
        res.json({ success: true, message });
    });

    router.get('/market-control/status', (req, res) => {
        const status = {};
        TRADE_PAIRS.forEach(pair => {
            // Read the current state
            status[pair] = candleOverride[pair] || 'auto'; 
        });

        res.json({
            success: true,
            marketStatus: status
        });
    });
    
    // ----------------------------------------------------------------------
    // COPY TRADE MANAGEMENT ROUTES (Unchanged)
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
