const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const Trade = require('../models/Trade');
const AdminCopyTrade = require('../models/AdminCopyTrade'); // NEW: Import AdminCopyTrade model
const authMiddleware = require('../middleware/auth');

// This route provides all data for the dashboard.html
router.get('/dashboard', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId).select('username balance');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        const recentTrades = await Trade.find({ userId: userId, status: 'closed' })
            .sort({ closeTime: -1 })
            .limit(5);
        const todayPnl = recentTrades.reduce((total, trade) => total + (trade.pnl || 0), 0);
        const marketData = req.app.get('marketData') || {};
        const assets = [
            'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
            'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'MATICUSDT'
        ];
        const marketInfo = assets.map(pair => {
            const data = marketData[pair];
            if (!data || typeof data.currentPrice !== 'number') { return null; }
            const lastCandle = (Array.isArray(data.candles) && data.candles[data.candles.length - 1]) || data.currentCandle;
            if (!lastCandle || typeof lastCandle.open !== 'number' || lastCandle.open === 0) {
                return { name: pair.replace('USDT', ''), ticker: pair.replace('USDT', ''), price: data.currentPrice || 0, change: 0 };
            }
            const change = ((data.currentPrice - lastCandle.open) / lastCandle.open) * 100;
            return { name: pair.replace('USDT', ''), ticker: pair.replace('USDT', ''), price: data.currentPrice, change: parseFloat(change.toFixed(2)) };
        }).filter(Boolean);

        res.json({
            success: true,
            data: {
                username: user.username,
                balance: user.balance,
                todayPnl: parseFloat(todayPnl.toFixed(2)),
                recentTrades: recentTrades.map(trade => ({ asset: trade.symbol, pnl: parseFloat((trade.pnl || 0).toFixed(2)), result: trade.result })),
                assets: marketInfo
            }
        });
    } catch (error) {
        console.error("Error fetching dashboard data:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// This route provides basic user info like balance and join date
router.get('/info', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }
        res.json({ success: true, user: user });
    } catch (error) {
        console.error("Error fetching user info:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// This route provides the user's referral data
router.get('/referral-info', authMiddleware, async (req, res) => {
    try {
        const userId = new mongoose.Types.ObjectId(req.user.id);
        const user = await User.findById(userId).select('referralCode referralCommissions');
        if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }
        const referralCount = await User.countDocuments({ referredBy: userId });
        res.json({
            success: true,
            referralCode: user.referralCode,
            referralCount: referralCount,
            totalCommissions: user.referralCommissions
        });
    } catch (error) {
        console.error("Error fetching referral info:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// This route provides all trading statistics, including the advanced ones
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const userId = new mongoose.Types.ObjectId(req.user.id);
        const stats = await Trade.aggregate([
            { $match: { userId: userId, status: 'closed' } },
            { $group: { _id: "$result", count: { $sum: 1 }, totalPnl: { $sum: "$pnl" }, totalVolume: { $sum: "$amount" } } }
        ]);
        const totalTrades = stats.reduce((acc, curr) => acc + curr.count, 0);
        const totalVolume = stats.reduce((acc, curr) => acc + (curr.totalVolume || 0), 0);
        const winsData = stats.find(s => s._id === 'WIN') || { count: 0 };
        const lossesData = stats.find(s => s._id === 'LOSS') || { count: 0 };
        const winnableTrades = winsData.count + lossesData.count;
        const winRate = winnableTrades > 0 ? (winsData.count / winnableTrades) * 100 : 0;
        const averageTradeSize = totalTrades > 0 ? totalVolume / totalTrades : 0;
        res.json({
            totalTrades,
            wins: winsData.count,
            losses: lossesData.count,
            ties: (stats.find(s => s._id === 'TIE') || { count: 0 }).count,
            winRate: winRate.toFixed(2),
            netPnl: (stats.reduce((acc, curr) => acc + (curr.totalPnl || 0), 0)).toFixed(2),
            volume: totalVolume.toFixed(2),
            averageTradeSize: averageTradeSize.toFixed(2)
        });
    } catch (error) {
        console.error("Error fetching user stats:", error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// This route handles changing the user's password
router.post('/change-password', authMiddleware, async (req, res) => {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmNewPassword) { return res.status(400).json({ success: false, message: 'All fields are required.' }); }
    if (newPassword !== confirmNewPassword) { return res.status(400).json({ success: false, message: 'New passwords do not match.' }); }
    if (newPassword.length < 6) { return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' }); }

    try {
        const user = await User.findById(req.user.id);
        if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }
        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) { return res.status(400).json({ success: false, message: 'Incorrect current password.' }); }
        user.password = newPassword;
        await user.save();
        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (error) {
        console.error("Change password error:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ADDED: This route provides the data for the volume tracker on the profile page
router.get('/volume-data', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('totalDeposits totalTradeVolume');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        res.json({
            success: true,
            totalDeposits: user.totalDeposits,
            totalTradeVolume: user.totalTradeVolume
        });
    } catch (error) {
        console.error("Error fetching volume data:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ----------------------------------------------------------------------
// NEW: COPY TRADE ROUTES FOR USERS
// ----------------------------------------------------------------------

// [GET] /api/user/copy-trades/available - Get available copy trades for users with balance > $100
router.get('/copy-trades/available', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('balance');
        
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                message: "User not found" 
            });
        }

        // Check if user has minimum balance of $100
        if (user.balance < 100) {
            return res.json({ 
                success: true, 
                copyTrades: [],
                message: "Minimum $100 balance required to view copy trades" 
            });
        }

        // Get active copy trades that haven't expired
        const availableTrades = await AdminCopyTrade.find({ 
            status: 'active',
            executionTime: { $gt: new Date() }
        })
        .populate('createdBy', 'username')
        .select('tradingPair direction percentage executionTime createdAt')
        .sort({ executionTime: 1 });

        res.json({ 
            success: true, 
            copyTrades: availableTrades,
            userBalance: user.balance
        });

    } catch (error) {
        console.error('Available Copy Trades Fetch Error:', error);
        res.status(500).json({ 
            success: false, 
            message: "Failed to fetch available copy trades" 
        });
    }
});

// [GET] /api/user/copy-trades/my-copies - Get user's copied trades history
router.get('/copy-trades/my-copies', authMiddleware, async (req, res) => {
    try {
        const userCopyTrades = await AdminCopyTrade.find({
            'userCopies.userId': req.user.id
        })
        .populate('createdBy', 'username')
        .select('tradingPair direction percentage executionTime status userCopies createdAt')
        .sort({ createdAt: -1 });

        const formattedTrades = userCopyTrades.map(trade => {
            const userCopy = trade.userCopies.find(copy => 
                copy.userId.toString() === req.user.id
            );
            
            return {
                _id: trade._id,
                tradingPair: trade.tradingPair,
                direction: trade.direction,
                percentage: trade.percentage,
                executionTime: trade.executionTime,
                status: trade.status,
                copiedAt: userCopy?.copiedAt,
                tradeAmount: userCopy?.tradeAmount,
                createdAt: trade.createdAt
            };
        });

        res.json({
            success: true,
            copiedTrades: formattedTrades
        });

    } catch (error) {
        console.error('User Copy Trades History Error:', error);
        res.status(500).json({ 
            success: false, 
            message: "Failed to fetch copy trade history" 
        });
    }
});

module.exports = router;