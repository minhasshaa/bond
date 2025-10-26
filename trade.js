const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminCopyTrade = require('./models/AdminCopyTrade');

// Global reference for marketData (populated in initialize)
let globalMarketData = {};
const POLL_INTERVAL_MS = 2000; // Reduced from 1000ms to 2000ms for better performance

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
        const expiredTrades = await AdminCopyTrade.find({
            status: 'active',
            executionTime: { $lte: now }
        }).lean();

        for (const copyTrade of expiredTrades) {
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

// ⭐ OPTIMIZED: Trade monitoring with better performance
async function runTradeMonitor(io, User, Trade, TRADE_PAIRS) {
    const lastProcessedCompletedCandleTs = {};
    const lastProcessedActivationTs = {};
    const lastCopyTradeCleanup = {};

    console.log("✅ Starting optimized trade monitor...");

    setInterval(async () => {
        try {
            const now = Date.now();
            
            for (const pair of TRADE_PAIRS) {
                const md = globalMarketData[pair];
                if (!md) continue;

                // 1. SETTLE ACTIVE TRADES (when a candle is complete)
                if (md.candles?.length > 0) {
                    const lastCompleted = md.candles[md.candles.length - 1];
                    const lastCompletedTs = new Date(lastCompleted.timestamp).getTime();
                    
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < lastCompletedTs) {
                        if (now > lastCompletedTs) { 
                            await settleTradesWrapper(io, User, Trade, pair, lastCompleted.close);
                            lastProcessedCompletedCandleTs[pair] = lastCompletedTs;
                        }
                    }
                }

                // 2. ACTIVATE SCHEDULED/PENDING TRADES (when a NEW candle starts)
                if (md.currentCandle) {
                    const currentCandleStartTime = new Date(md.currentCandle.timestamp);
                    const activationTs = currentCandleStartTime.getTime();

                    if (!lastProcessedActivationTs[pair] || lastProcessedActivationTs[pair] < activationTs) {
                        await activateTradesWrapper(io, User, Trade, pair, md.currentCandle.timestamp, md.currentCandle.open);
                        lastProcessedActivationTs[pair] = activationTs;
                    }
                }
            }

            // --- Copy Trade Cleanup (every 10 seconds instead of 5) ---
            if (!lastCopyTradeCleanup.global || (now - lastCopyTradeCleanup.global) > 10000) {
                await cleanupExpiredCopyTrades(io, User, Trade);
                lastCopyTradeCleanup.global = now;
            }
        } catch (err) {
            console.error("Trade monitor error:", err.message);
        }
    }, POLL_INTERVAL_MS);
}

// ⭐ OPTIMIZED: Wrapper for Activation Logic
async function activateTradesWrapper(io, User, Trade, pair, candleTimestamp, entryPrice) {
    try {
        await activateScheduledTradesForPair(io, Trade, pair, candleTimestamp, entryPrice);
        await activatePendingTradesForPair(io, User, Trade, pair, entryPrice);
    } catch (err) {
        console.error("Trade Activation Error:", err.message);
    }
}

// ⭐ OPTIMIZED: Wrapper for Settlement Logic
async function settleTradesWrapper(io, User, Trade, pair, exitPrice) {
    try {
        await settleActiveTradesForPair(io, User, Trade, pair, exitPrice);
    } catch (err) {
        console.error("Trade Settlement Error:", err.message);
    }
}

// ⭐ OPTIMIZED: Initialize function without candleOverride
async function initialize(io, User, Trade, marketData, TRADE_PAIRS) {
    globalMarketData = marketData;

    // ⭐ OPTIMIZATION: Set marketData directly on io for better access
    io.marketData = marketData;

    console.log("✅ Trade module initialized - Optimized performance");

    // ⭐ OPTIMIZED: Socket.IO authentication - simplified
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

    // START THE OPTIMIZED MONITORING LOOP
    runTradeMonitor(io, User, Trade, TRADE_PAIRS);

    io.on("connection", async (socket) => {
        try {
            const userId = socket.decoded.id;
            const user = await User.findById(userId);
            if (!user) return socket.disconnect();
            
            socket.join(user._id.toString());

            // ⭐ OPTIMIZED: Single database query for user data
            const [userTrades, freshUser] = await Promise.all([
                Trade.find({ userId: user._id })
                    .sort({ timestamp: -1 })
                    .limit(50)
                    .lean(), // Use lean for faster reads
                User.findById(user._id)
            ]);

            socket.emit("init", { 
                balance: freshUser.balance, 
                tradeHistory: userTrades,
                marketData: globalMarketData
            });

            // ⭐ OPTIMIZED: Trade placement with better error handling
            socket.on("trade", async (data) => {
                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    const { asset, direction, amount } = data;
                    
                    // Validation
                    if (!TRADE_PAIRS.includes(asset)) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Invalid asset." });
                    }
                    
                    if (!["UP", "DOWN"].includes(direction)) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Invalid direction." });
                    }

                    const tradeAmount = parseFloat(amount);
                    if (isNaN(tradeAmount) || tradeAmount <= 0) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Invalid trade amount." });
                    }

                    // Check for existing trades and balance in parallel
                    const [existingTrade, currentUser] = await Promise.all([
                        Trade.findOne({ 
                            userId: user._id, 
                            status: { $in: ["pending", "active", "scheduled"] } 
                        }).session(session),
                        User.findById(user._id).session(session)
                    ]);

                    if (existingTrade) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { 
                            message: `You already have an active trade. Please wait for it to complete.` 
                        });
                    }

                    if (currentUser.balance < tradeAmount) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { 
                            message: `Insufficient balance. Required: $${tradeAmount.toFixed(2)}, Available: $${currentUser.balance.toFixed(2)}` 
                        });
                    }

                    const finalDirection = await getTradeDirectionBasedOnVolume(asset, direction);

                    // Update user balance and create trade
                    currentUser.balance -= tradeAmount;
                    await currentUser.save({ session });

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

                    socket.emit("trade_pending", { 
                        trade: trade.toObject(), 
                        balance: currentUser.balance 
                    });

                } catch (err) {
                    await session.abortTransaction();
                    session.endSession();
                    console.error("Trade placement error:", err);
                    socket.emit("error", { message: "Could not place trade." });
                }
            });

            // ⭐ OPTIMIZED: Copy Trade with better performance
            socket.on("copy_trade", async (data) => {
                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    const { copyTradeId } = data;

                    const [freshUser, existingTrade, copyTrade] = await Promise.all([
                        User.findById(userId).session(session),
                        Trade.findOne({ 
                            userId: user._id, 
                            status: { $in: ["pending", "active", "scheduled"] } 
                        }).session(session),
                        AdminCopyTrade.findById(copyTradeId).session(session)
                    ]);

                    if (!freshUser || freshUser.balance < 100) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Minimum $100 balance required to copy trades" });
                    }

                    if (existingTrade) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { 
                            message: `You already have an active trade. Please wait for it to complete before copying.` 
                        });
                    }

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

                    await Promise.all([
                        scheduledTrade.save({ session }),
                        copyTrade.save({ session }),
                        freshUser.save({ session })
                    ]);

                    await session.commitTransaction();
                    session.endSession();

                    const timeUntilExecution = executionTime - new Date();
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
                        scheduledTrade: scheduledTrade.toObject()
                    });

                    socket.emit("trade_scheduled", { 
                        trade: scheduledTrade.toObject(), 
                        balance: freshUser.balance 
                    });

                } catch (error) {
                    await session.abortTransaction();
                    session.endSession();
                    console.error('Copy trade error:', error);
                    socket.emit("error", { message: "Failed to copy trade" });
                }
            });

            // ⭐ OPTIMIZED: Schedule trade
            socket.on("schedule_trade", async (data) => {
                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    const { asset, direction, scheduledTime, amount } = data;
                    
                    if (!TRADE_PAIRS.includes(asset)) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Invalid asset." });
                    }
                    
                    if (!["UP", "DOWN"].includes(direction)) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Invalid direction." });
                    }

                    const tradeAmount = parseFloat(amount);
                    if (isNaN(tradeAmount) || tradeAmount <= 0) {
                        await session.abptTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Invalid trade amount." });
                    }

                    const [existingTrade, freshUser] = await Promise.all([
                        Trade.findOne({ 
                            userId: user._id, 
                            status: { $in: ["pending", "active", "scheduled"] } 
                        }).session(session),
                        User.findById(user._id).session(session)
                    ]);

                    if (existingTrade) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { 
                            message: `You already have an active trade. Please wait for it to complete.` 
                        });
                    }

                    if (freshUser.balance < tradeAmount) {
                        await session.abortTransaction();
                        session.endSession();
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
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Please select a time in the next 10 minutes." });
                    }

                    const finalScheduleDtUTC = userScheduledTimeToday; 
                    finalScheduleDtUTC.setSeconds(0, 0); 

                    freshUser.balance -= tradeAmount;
                    await freshUser.save({ session });

                    const trade = new Trade({
                        userId: user._id,
                        amount: tradeAmount,
                        direction: finalDirection, 
                        asset,
                        status: "scheduled",
                        scheduledTime: finalScheduleDtUTC
                    });
                    await trade.save({ session });

                    await session.commitTransaction();
                    session.endSession();

                    socket.emit("trade_scheduled", { 
                        trade: trade.toObject(), 
                        balance: freshUser.balance 
                    });

                } catch (err) {
                    await session.abortTransaction();
                    session.endSession();
                    console.error("Error in schedule_trade:", err);
                    socket.emit("error", { message: "Could not schedule trade." });
                }
            });

            // ⭐ OPTIMIZED: Cancel trade
            socket.on("cancel_trade", async (data) => {
                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    const trade = await Trade.findOne({
                        _id: data.tradeId,
                        userId: user._id,
                        status: { $in: ["pending", "scheduled"] }
                    }).session(session);
                    
                    if (!trade) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { message: "Trade not found or cannot be cancelled." });
                    }

                    const freshUser = await User.findById(user._id).session(session);
                    freshUser.balance += trade.amount;
                    
                    await Promise.all([
                        freshUser.save({ session }),
                        Trade.findByIdAndUpdate(trade._id, { status: "cancelled" }, { session })
                    ]);

                    await session.commitTransaction();
                    session.endSession();

                    socket.emit("trade_cancelled", { 
                        tradeId: trade._id, 
                        balance: freshUser.balance 
                    });

                } catch (err) {
                    await session.abortTransaction();
                    session.endSession();
                    socket.emit("error", { message: "Could not cancel trade." });
                }
            });

            socket.on("disconnect", () => {
                // Clean up if needed
            });

        } catch (err) {
            socket.disconnect();
        }
    });
}

// ⭐ OPTIMIZED: Helper Functions with better performance

async function activateScheduledTradesForPair(io, Trade, pair, candleTimestamp, entryPrice) {
    try {
        const candleTime = new Date(candleTimestamp);
        candleTime.setSeconds(0, 0);

        const scheduleds = await Trade.find({ 
            status: "scheduled", 
            asset: pair, 
            scheduledTime: { $lte: candleTime } 
        });

        const updatePromises = scheduleds.map(async (t) => {
            try {
                t.status = "active";
                t.entryPrice = entryPrice;
                t.activationTimestamp = new Date(); 
                await t.save();
                io.to(t.userId.toString()).emit("trade_active", { trade: t.toObject() });
            } catch (innerErr) {
                console.error(`Error saving active scheduled trade ${t._id}:`, innerErr.message);
            }
        });

        await Promise.all(updatePromises);
    } catch (err) {
        console.error("Error finding scheduled trades:", err);
    }
}

async function activatePendingTradesForPair(io, User, Trade, pair, entryPrice) {
    try {
        const pendings = await Trade.find({ status: "pending", asset: pair });
        
        const updatePromises = pendings.map(async (t) => {
            try {
                t.status = "active";
                t.entryPrice = entryPrice;
                t.activationTimestamp = new Date();
                await t.save();
                io.to(t.userId.toString()).emit("trade_active", { trade: t.toObject() });
            } catch (innerErr) {
                console.error(`Error saving active pending trade ${t._id}:`, innerErr.message);
            }
        });

        await Promise.all(updatePromises);
    } catch (err) {
        console.error("Error finding pending trades:", err);
    }
}

async function settleActiveTradesForPair(io, User, Trade, pair, exitPrice) {
    try {
        const actives = await Trade.find({ status: "active", asset: pair });
        
        const settlementPromises = actives.map(async (t) => {
            try {
                const win = (t.direction === "UP" && exitPrice > t.entryPrice) || 
                           (t.direction === "DOWN" && exitPrice < t.entryPrice);
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
                    trade: t.toObject(), 
                    balance: userAfter.balance,
                    todayPnl: parseFloat(todayPnl.toFixed(2)) 
                });

            } catch (innerErr) {
                console.error(`Error processing trade settlement for trade ${t._id}:`, innerErr.message);
            }
        });

        await Promise.all(settlementPromises);
    } catch (err) {
        console.error("Error finding active trades:", err);
    }
}

module.exports = { initialize };
