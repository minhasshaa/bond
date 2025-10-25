const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminCopyTrade = require('./models/AdminCopyTrade');

// Global reference for marketData (populated in initialize)
let globalMarketData = {};
const POLL_INTERVAL_MS = 1000; // Check every second

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

        console.log(`Copy trade ${copyTradeId} marked as executed`);

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Copy trade execution error:', error);
    }
}

// --- Auto-cleanup expired copy trades ---
async function cleanupExpiredCopyTrades(io, User, Trade) {
    try {
        const now = new Date();
        // Use lean() for faster read access as we are not modifying the trade during this find
        const expiredTrades = await AdminCopyTrade.find({
            status: 'active',
            executionTime: { $lte: now }
        }).lean();

        for (const copyTrade of expiredTrades) {
            // ⭐ FIX: Wrap individual execution to prevent one failure from stopping the loop
            try {
                await executeCopyTrade(io, User, Trade, copyTrade._id);
            } catch (innerErr) {
                console.error(`Inner error executing copy trade ${copyTrade._id}:`, innerErr);
            }
        }
    } catch (error) {
        console.error('Copy trade cleanup error (outer loop):', error);
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
        console.error('Error calculating volume-based direction:', error);
        return userRequestedDirection;
    }
}

// ⭐ FIX: Encapsulated trade settlement and activation functions to ensure logging
async function runTradeMonitor(io, User, Trade, TRADE_PAIRS) {
    const lastProcessedCompletedCandleTs = {};
    const lastProcessedActivationTs = {};
    const lastCopyTradeCleanup = {};

    setInterval(async () => {
        try {
            for (const pair of TRADE_PAIRS) {
                const md = globalMarketData[pair];
                if (!md) continue;

                // 1. SETTLE ACTIVE TRADES (when a candle is complete)
                if (md.candles?.length > 0) {
                    const lastCompleted = md.candles[md.candles.length - 1];
                    const lastCompletedTs = new Date(lastCompleted.timestamp).getTime();
                    
                    // ⭐ FIX: Ensure we only settle once per unique candle completion timestamp
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < lastCompletedTs) {
                        if (Date.now() > lastCompletedTs) { 
                             // ⭐ FIX: Call the wrapper function for settlement
                             await settleTradesWrapper(io, User, Trade, pair, lastCompleted.close);
                             lastProcessedCompletedCandleTs[pair] = lastCompletedTs;
                        }
                    }
                }

                // 2. ACTIVATE SCHEDULED/PENDING TRADES (when a NEW candle starts)
                if (md.currentCandle) {
                    const currentCandleStartTime = new Date(md.currentCandle.timestamp);
                    const activationTs = currentCandleStartTime.getTime();

                    // ⭐ FIX: Ensure we only activate once per unique candle start timestamp
                    if (!lastProcessedActivationTs[pair] || lastProcessedActivationTs[pair] < activationTs) {
                        
                        // ⭐ FIX: Call the wrapper function for activation
                        await activateTradesWrapper(io, User, Trade, pair, md.currentCandle.timestamp, md.currentCandle.open);
                        
                        lastProcessedActivationTs[pair] = activationTs;
                    }
                }
            }

            // --- Copy Trade Cleanup ---
            const now = Date.now();
            if (!lastCopyTradeCleanup.global || (now - lastCopyTradeCleanup.global) > 5000) { // Every 5 seconds
                await cleanupExpiredCopyTrades(io, User, Trade);
                lastCopyTradeCleanup.global = now;
            }
        } catch (err) {
            // ⭐ CRITICAL FIX: This catches any crash inside the main setInterval loop
            console.error("Trade monitor FATAL crash (loop stopped):", err.stack);
            // This error indicates the loop has stopped and trades will freeze.
        }
    }, POLL_INTERVAL_MS);
}

// ⭐ Wrapper for Activation Logic
async function activateTradesWrapper(io, User, Trade, pair, candleTimestamp, entryPrice) {
    try {
        await activateScheduledTradesForPair(io, Trade, pair, candleTimestamp, entryPrice);
        await activatePendingTradesForPair(io, User, Trade, pair, entryPrice);
    } catch (err) {
        // This logs any fatal error during activation process but allows the monitor loop to continue
        console.error("Critical Trade Activation Error:", err.message);
    }
}

// ⭐ Wrapper for Settlement Logic
async function settleTradesWrapper(io, User, Trade, pair, exitPrice) {
    try {
        await settleActiveTradesForPair(io, User, Trade, pair, exitPrice);
    } catch (err) {
        // This logs any fatal error during settlement process but allows the monitor loop to continue
        console.error("Critical Trade Settlement Error:", err.message);
    }
}
// --- END NEW MONITORING LOGIC ---


async function initialize(io, User, Trade, marketData, TRADE_PAIRS) {
    globalMarketData = marketData; // Set global reference

    io.engine.marketData = marketData; 

    io.use((socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (!token) return next(new Error("Authentication error"));
            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
                if (err) return next(new Error("Authentication error"));
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

            const clientMarketData = {};
            for (const p of TRADE_PAIRS) {
                clientMarketData[p] = {
                    currentPrice: globalMarketData[p]?.currentPrice || 0,
                    candles: [...(globalMarketData[p]?.candles || []), ...(globalMarketData[p]?.currentCandle ? [globalMarketData[p].currentCandle] : [])]
                };
            }

            const userTrades = await Trade.find({ userId: user._id }).sort({ timestamp: -1 }).limit(50);
            socket.emit("init", { marketData: clientMarketData, balance: user.balance, tradeHistory: userTrades });

            for (const p of TRADE_PAIRS) {
                socket.emit("market_data", { asset: p, candles: clientMarketData[p].candles, currentPrice: clientMarketData[p].currentPrice });
            }

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
                    console.error("Trade placement error:", err);
                    socket.emit("error", { message: "Could not place trade." });
                }
            });

            // --- NEW: Copy Trade Event ---
            socket.on("copy_trade", async (data) => {
                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    const { copyTradeId } = data;

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

                    if (freshUser.balance < tradeAmount) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { 
                            message: `Insufficient balance. Required: $${tradeAmount.toFixed(2)}, Available: $${freshUser.balance.toFixed(2)}` 
                        });
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
                    const minutesUntilExecution = Math.floor(timeUntilExecution / (1000 * 60));

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
                    await session.abortTransaction();
                    session.endSession();
                    console.error('Copy trade error:', error);
                    socket.emit("error", { message: "Failed to copy trade" });
                }
            });

            socket.on("schedule_trade", async (data) => {
                try {
                    const { asset, direction, scheduledTime, amount } = data;
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

                    const serverNowUTC = new Date();
                    
                    const [hour, minute] = scheduledTime.split(":").map(Number);
                    
                    const userScheduledTimeToday = new Date(serverNowUTC);
                    userScheduledTimeToday.setUTCHours(hour, minute, 0, 0); 

                    const tenMinutesFromNow = new Date(serverNowUTC.getTime() + (10 * 60 * 1000));
                    
                    if (userScheduledTimeToday <= serverNowUTC || userScheduledTimeToday > tenMinutesFromNow) {
                        return socket.emit("error", { message: "Please select a time in the next 10 minutes." });
                    }

                    const finalScheduleDtUTC = userScheduledTimeToday; 
                    finalScheduleDtUTC.setSeconds(0, 0); 

                    freshUser.balance -= tradeAmount;
                    await freshUser.save();

                    const trade = new Trade({
                        userId: user._id,
                        amount: tradeAmount,
                        direction: finalDirection, 
                        asset,
                        status: "scheduled",
                        scheduledTime: finalScheduleDtUTC
                    });
                    await trade.save();

                    io.to(user._id.toString()).emit("trade_scheduled", { trade, balance: freshUser.balance });
                } catch (err) {
                    console.error("Error in schedule_trade:", err);
                    socket.emit("error", { message: "Could not schedule trade." });
                }
            });

            socket.on("cancel_trade", async (data) => {
                try {
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
                    socket.emit("error", { message: "Could not cancel trade." });
                }
            });

            socket.on("disconnect", () => { });
        } catch (err) {
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

        // ⭐ FIX: Added internal try/catch for save operations
        for (const t of scheduleds) {
            try {
                t.status = "active";
                t.entryPrice = entryPrice;
                t.activationTimestamp = new Date(); 
                await t.save();
                io.to(t.userId.toString()).emit("trade_active", { trade: t });
            } catch (innerErr) {
                 console.error(`Error saving active scheduled trade ${t._id}:`, innerErr.message);
            }
        }
    } catch (err) {
        console.error("Error finding scheduled trades (outer loop):", err);
    }
}

async function activatePendingTradesForPair(io, User, Trade, pair, entryPrice) {
    try {
        const pendings = await Trade.find({ status: "pending", asset: pair });
        // ⭐ FIX: Added internal try/catch for save operations
        for (const t of pendings) {
            try {
                t.status = "active";
                t.entryPrice = entryPrice;
                t.activationTimestamp = new Date();
                await t.save();
                io.to(t.userId.toString()).emit("trade_active", { trade: t });
            } catch (innerErr) {
                 console.error(`Error saving active pending trade ${t._id}:`, innerErr.message);
            }
        }
    } catch (err) {
        console.error("Error finding pending trades (outer loop):", err);
    }
}

async function settleActiveTradesForPair(io, User, Trade, pair, exitPrice) {
    try {
        const actives = await Trade.find({ status: "active", asset: pair });
        // ⭐ FIX: Added internal try/catch for save operations
        for (const t of actives) {
            try {
                const win = (t.direction === "UP" && exitPrice > t.entryPrice) || (t.direction === "DOWN" && exitPrice < t.entryPrice);
                const tie = exitPrice === t.entryPrice;
                const pnl = tie ? 0 : (win ? t.amount * 0.9 : -t.amount); // 90% payout on win

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
                            balance: t.amount + pnl, // Refund original amount + P&L
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

                console.log(`Trade settled for user ${t.userId}: P&L $${pnl}, Today's Total P&L: $${todayPnl}`);
            } catch (innerErr) {
                 console.error(`Error processing/saving trade settlement for trade ${t._id}:`, innerErr.message);
            }
        }
    } catch (err) {
        console.error("Error finding active trades (outer loop):", err);
    }
}

module.exports = { initialize };
