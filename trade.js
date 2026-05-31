// trade.js - CORRECTED VERSION
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminCopyTrade = require('./models/AdminCopyTrade');

let globalMarketData = {};
const POLL_INTERVAL_MS = 1000;

// ------------------ RATE LIMITER HELPER ------------------
function createRateLimiter(limitMs) {
    const lastCall = {};
    return function (userId) {
        const now = Date.now();
        if (lastCall[userId] && now - lastCall[userId] < limitMs) {
            return false;
        }
        lastCall[userId] = now;
        return true;
    };
}
const tradeRateLimit = createRateLimiter(2000);
const cancelRateLimit = createRateLimiter(1000);

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
        // FIX 1: Log errors instead of silently swallowing them
        console.error(`[executeCopyTrade] Error executing copy trade ${copyTradeId}:`, error.message);
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
            } catch (innerErr) {
                // FIX 1: Log inner errors
                console.error(`[cleanupExpiredCopyTrades] Failed for trade ${copyTrade._id}:`, innerErr.message);
            }
        }
    } catch (error) {
        // FIX 1: Log errors
        console.error('[cleanupExpiredCopyTrades] Error:', error.message);
    }
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
        // FIX 1: Log errors
        console.error('[getTradeDirectionBasedOnVolume] Error:', error.message);
        return userRequestedDirection;
    }
}

// Trade monitoring logic
async function runTradeMonitor(io, User, Trade, TRADE_PAIRS) {
    const lastProcessedCompletedCandleTs = {};
    const lastProcessedActivationTs = {};
    const lastCopyTradeCleanup = {};

    setInterval(async () => {
        try {
            for (const pair of TRADE_PAIRS) {
                const md = globalMarketData[pair];
                if (!md) continue;

                // ACTIVATION LOGIC
                if (md.currentCandle) {
                    const activationTs = new Date(md.currentCandle.timestamp).getTime();
                    if (!lastProcessedActivationTs[pair] || lastProcessedActivationTs[pair] < activationTs) {
                        await activateScheduledTradesForPair(io, Trade, pair, md.currentCandle.timestamp, md.currentCandle.open);
                        await activatePendingTradesForPair(io, User, Trade, pair, md.currentCandle.timestamp, md.currentCandle.open);
                        lastProcessedActivationTs[pair] = activationTs;
                    }
                }

                // SETTLEMENT LOGIC
                if (md.candles?.length > 0) {
                    const lastCompleted = md.candles[md.candles.length - 1];
                    const lastCompletedTs = new Date(lastCompleted.timestamp).getTime();
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < lastCompletedTs) {
                        await settleActiveTradesForPair(io, User, Trade, pair, lastCompleted);
                        lastProcessedCompletedCandleTs[pair] = lastCompletedTs;
                    }
                }
            }

            // --- Copy Trade Cleanup ---
            const now = Date.now();
            if (!lastCopyTradeCleanup.global || (now - lastCopyTradeCleanup.global) > 5000) {
                await cleanupExpiredCopyTrades(io, User, Trade);
                lastCopyTradeCleanup.global = now;
            }
        } catch (err) {
            // FIX 1: Log errors
            console.error('[runTradeMonitor] Unexpected error:', err.message);
        }
    }, POLL_INTERVAL_MS);
}

async function initialize(io, User, Trade, marketData, TRADE_PAIRS) {
    globalMarketData = marketData;
    io.engine.marketData = marketData;

    // FIX 2: REMOVED duplicate io.use() JWT middleware
    // JWT verification is already handled in index.js
    // Adding it again here caused every connection to be verified twice

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

            // --- Instant Trade ---
            socket.on("trade", async (data) => {
                try {
                    // FIX 8: Rate limit trade placement
                    if (!tradeRateLimit(userId)) {
                        return socket.emit("error", { message: "Too many requests. Please wait." });
                    }

                    const { asset, direction, amount } = data;
                    if (!TRADE_PAIRS.includes(asset)) return socket.emit("error", { message: "Invalid asset." });
                    if (!["UP", "DOWN"].includes(direction)) return socket.emit("error", { message: "Invalid direction." });

                    const tradeAmount = parseFloat(amount);
                    if (isNaN(tradeAmount) || tradeAmount <= 0) {
                        return socket.emit("error", { message: "Invalid trade amount." });
                    }

                    // FIX 4: Use MongoDB session to prevent race conditions on balance deduction
                    const session = await mongoose.startSession();
                    session.startTransaction();

                    try {
                        const existingTrade = await Trade.findOne({ 
                            userId: user._id, 
                            status: { $in: ["pending", "active", "scheduled"] } 
                        }).session(session);

                        if (existingTrade) {
                            await session.abortTransaction();
                            session.endSession();
                            return socket.emit("error", { 
                                message: `You already have an active trade. Please wait for it to complete.` 
                            });
                        }

                        const freshUser = await User.findById(user._id).session(session);

                        if (freshUser.balance < tradeAmount) {
                            await session.abortTransaction();
                            session.endSession();
                            return socket.emit("error", { 
                                message: `Insufficient balance. Required: $${tradeAmount.toFixed(2)}, Available: $${freshUser.balance.toFixed(2)}` 
                            });
                        }

                        const finalDirection = await getTradeDirectionBasedOnVolume(asset, direction);

                        freshUser.balance -= tradeAmount;
                        await freshUser.save({ session });

                        const trade = new Trade({
                            userId: user._id,
                            amount: tradeAmount,
                            direction: finalDirection, 
                            asset,
                            status: "pending", 
                            timestamp: new Date()
                        });
                        await trade.save({ session });

                        await session.commitTransaction();
                        session.endSession();

                        io.to(user._id.toString()).emit("trade_pending", { trade, balance: freshUser.balance });

                    } catch (txErr) {
                        console.error('[trade] Transaction error:', txErr.message);
                        await session.abortTransaction();
                        session.endSession();
                        socket.emit("error", { message: "Could not place trade. Please try again." });
                    }

                } catch (err) {
                    console.error('[trade] Unexpected error:', err.message);
                    socket.emit("error", { message: "Could not place trade." });
                }
            });

            // --- Copy Trade ---
            socket.on("copy_trade", async (data) => {
                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    const { copyTradeId } = data;

                    // FIX 7: Validate copyTradeId before querying
                    if (!mongoose.Types.ObjectId.isValid(copyTradeId)) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Invalid copy trade ID." });
                    }

                    const freshUser = await User.findById(userId).session(session);
                    if (!freshUser || freshUser.balance < 100) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Minimum $100 balance required to copy trades" });
                    }

                    const existingTrade = await Trade.findOne({ 
                        userId: user._id, 
                        status: { $in: ["pending", "active", "scheduled"] } 
                    }).session(session);

                    if (existingTrade) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { 
                            message: `You already have an active trade. Please wait for it to complete before copying.` 
                        });
                    }

                    const copyTrade = await AdminCopyTrade.findById(copyTradeId).session(session);
                    if (!copyTrade || copyTrade.status !== 'active' || copyTrade.executionTime <= new Date()) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "This copy trade is no longer available" });
                    }

                    const alreadyCopied = copyTrade.userCopies.find(
                        copy => copy.userId.toString() === userId
                    );

                    if (alreadyCopied) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "You have already copied this trade" });
                    }

                    const tradeAmount = (freshUser.balance * copyTrade.percentage) / 100;

                    // FIX 6: Correct balance validation
                    if (!tradeAmount || tradeAmount <= 0) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Calculated trade amount is invalid." });
                    }

                    const executionTime = new Date(copyTrade.executionTime);
                    executionTime.setSeconds(0, 0); 

                    const scheduledTrade = new Trade({
                        userId: user._id,
                        amount: tradeAmount,
                        direction: copyTrade.direction === 'CALL' ? 'UP' : 'DOWN',
                        asset: copyTrade.tradingPair,
                        status: "scheduled",
                        scheduledTime: executionTime, 
                        timestamp: new Date(),
                        isCopyTrade: true,
                        originalCopyTradeId: copyTrade._id
                    });

                    freshUser.balance -= tradeAmount;

                    copyTrade.userCopies.push({
                        userId: userId,
                        copiedAt: new Date(),
                        tradeAmount: tradeAmount
                    });

                    await scheduledTrade.save({ session });
                    await copyTrade.save({ session });
                    await freshUser.save({ session });

                    await session.commitTransaction();
                    session.endSession();

                    const now = new Date();
                    const timeUntilExecution = executionTime - now;
                    const minutesUntilExecution = Math.max(0, Math.floor(timeUntilExecution / (1000 * 60)));

                    socket.emit("copy_trade_success", {
                        message: `Successfully copied trade! $${tradeAmount.toFixed(2)} scheduled to execute in ${minutesUntilExecution} minutes.`,
                        copyTrade: {
                            tradingPair: copyTrade.tradingPair,
                            direction: copyTrade.direction,
                            percentage: copyTrade.percentage,
                            executionTime: executionTime,
                            tradeAmount: tradeAmount,
                            minutesUntilExecution: minutesUntilExecution
                        },
                        scheduledTrade: scheduledTrade
                    });

                    io.to(user._id.toString()).emit("trade_scheduled", { 
                        trade: scheduledTrade, 
                        balance: freshUser.balance 
                    });

                } catch (error) {
                    console.error('[copy_trade] Error:', error.message);
                    await session.abortTransaction();
                    session.endSession();
                    socket.emit("error", { message: "Failed to copy trade" });
                }
            });

            socket.on("cancel_trade", async (data) => {
                try {
                    // FIX 8: Rate limit cancel requests
                    if (!cancelRateLimit(userId)) {
                        return socket.emit("error", { message: "Too many requests. Please wait." });
                    }

                    // FIX 7: Validate tradeId before querying MongoDB
                    if (!data.tradeId || !mongoose.Types.ObjectId.isValid(data.tradeId)) {
                        return socket.emit("error", { message: "Invalid trade ID." });
                    }

                    const trade = await Trade.findOne({
                        _id: data.tradeId,
                        userId: user._id,
                        status: { $in: ["pending", "scheduled"] }
                    });
                    if (!trade) return socket.emit("error", { message: "Trade not found or cannot be cancelled." });

                    const freshUser = await User.findById(user._id);
                    freshUser.balance += trade.amount;
                    await freshUser.save();

                    trade.status = "cancelled";
                    await trade.save();
                    io.to(user._id.toString()).emit("trade_cancelled", { tradeId: trade._id, balance: freshUser.balance });
                } catch (err) {
                    console.error('[cancel_trade] Error:', err.message);
                    socket.emit("error", { message: "Could not cancel trade." });
                }
            });

            socket.on("disconnect", () => {
                console.log(`User ${userId} disconnected.`);
            });

        } catch (err) {
            console.error('[connection] Error during socket setup:', err.message);
            socket.disconnect();
        }
    });
}

// --- Helper Functions ---

async function activateScheduledTradesForPair(io, Trade, pair, candleTimestamp, entryPrice) {
    try {
        const candleTime = new Date(candleTimestamp);
        candleTime.setSeconds(0, 0);

        const scheduleds = await Trade.find({ 
            status: "scheduled", 
            asset: pair, 
            scheduledTime: { $lte: candleTime }
        });

        for (const t of scheduleds) {
            t.status = "active";
            t.entryPrice = entryPrice;
            t.activationTimestamp = candleTime; 
            await t.save();
            io.to(t.userId.toString()).emit("trade_active", { trade: t });
        }
    } catch (err) {
        console.error(`[activateScheduledTradesForPair] Error for ${pair}:`, err.message);
    }
}

async function activatePendingTradesForPair(io, User, Trade, pair, candleTimestamp, entryPrice) {
    try {
        const candleTime = new Date(candleTimestamp);

        // FIX 5: Only activate trades placed BEFORE this candle started
        const pendings = await Trade.find({ 
            status: "pending", 
            asset: pair,
            timestamp: { $lt: candleTime }
        });

        for (const t of pendings) {
            t.status = "active";
            t.entryPrice = entryPrice;
            t.activationTimestamp = candleTimestamp; 
            await t.save();
            io.to(t.userId.toString()).emit("trade_active", { trade: t });
        }
    } catch (err) {
        console.error(`[activatePendingTradesForPair] Error for ${pair}:`, err.message);
    }
}

async function settleActiveTradesForPair(io, User, Trade, pair, lastCompletedCandle) {
    const exitPrice = lastCompletedCandle.close;
    const completedCandleStartTime = new Date(lastCompletedCandle.timestamp).getTime(); 
    const settlementEligibilityTime = completedCandleStartTime + (60 * 1000);

    try {
        const actives = await Trade.find({ status: "active", asset: pair });
        for (const t of actives) {
            
            const tradeActivationTime = new Date(t.activationTimestamp).getTime();
            const tradeShouldCloseBy = tradeActivationTime + (60 * 1000); 

            if (tradeShouldCloseBy <= settlementEligibilityTime) {
                
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
            }
        }
    } catch (err) {
        console.error(`[settleActiveTradesForPair] Error for ${pair}:`, err.message);
    }
}

module.exports = { initialize };
