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

// Trade monitoring logic - FIXED SCHEDULING AND SETTLEMENT
async function runTradeMonitor(io, User, Trade, TRADE_PAIRS) {
    const lastProcessedCompletedCandleTs = {};
    const lastProcessedActivationTs = {};
    const lastCopyTradeCleanup = {};

    setInterval(async () => {
        try {
            for (const pair of TRADE_PAIRS) {
                const md = globalMarketData[pair];
                if (!md) continue;

                // ACTIVATION LOGIC - FIXED
                if (md.currentCandle) {
                    const activationTs = new Date(md.currentCandle.timestamp).getTime();
                    if (!lastProcessedActivationTs[pair] || lastProcessedActivationTs[pair] < activationTs) {
                        // Pass the candle timestamp (the minute the trade becomes active)
                        await activateScheduledTradesForPair(io, Trade, pair, md.currentCandle.timestamp, md.currentCandle.open);
                        await activatePendingTradesForPair(io, User, Trade, pair, md.currentCandle.timestamp, md.currentCandle.open);
                        lastProcessedActivationTs[pair] = activationTs;
                    }
                }

                // SETTLEMENT LOGIC - FIXED
                if (md.candles?.length > 0) {
                    const lastCompleted = md.candles[md.candles.length - 1];
                    const lastCompletedTs = new Date(lastCompleted.timestamp).getTime();
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < lastCompletedTs) {
                        // Pass the completed candle object to ensure the timestamp is used for duration check
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
            console.error("Trade monitor error:", err);
        }
    }, POLL_INTERVAL_MS);
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
                    console.error("Trade error:", err);
                    socket.emit("error", { message: "Could not place trade." });
                }
            });

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
                    console.error("Copy trade error:", error);
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
                    
                    // FIXED: Better time validation with exact minute boundaries
                    if (userScheduledTimeToday <= serverNowUTC) {
                        return socket.emit("error", { message: "Please select a future time." });
                    }
                    
                    if (userScheduledTimeToday > tenMinutesFromNow) {
                        return socket.emit("error", { message: "Please select a time within the next 10 minutes." });
                    }

                    // Ensure scheduled time is at exact minute boundaries
                    const finalScheduleDtUTC = new Date(userScheduledTimeToday);
                    finalScheduleDtUTC.setSeconds(0, 0);

                    freshUser.balance -= tradeAmount;
                    await freshUser.save();

                    const trade = new Trade({
                        userId: user._id,
                        amount: tradeAmount,
                        direction: finalDirection, 
                        asset,
                        status: "scheduled",
                        scheduledTime: finalScheduleDtUTC,
                        timestamp: new Date()
                    });
                    await trade.save();

                    io.to(user._id.toString()).emit("trade_scheduled", { trade, balance: freshUser.balance });
                } catch (err) {
                    console.error("Schedule trade error:", err);
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
                    console.error("Cancel trade error:", err);
                    socket.emit("error", { message: "Could not cancel trade." });
                }
            });

            socket.on("disconnect", () => { });
        } catch (err) {
            console.error("Connection error:", err);
            socket.disconnect();
        }
    });
}

// --- FIXED HELPER FUNCTIONS ---

async function activateScheduledTradesForPair(io, Trade, pair, candleTimestamp, entryPrice) {
    try {
        // Normalize both times to minute precision for accurate comparison
        const candleTime = new Date(candleTimestamp);
        candleTime.setSeconds(0, 0);
        
        const scheduledTrades = await Trade.find({ 
            status: "scheduled", 
            asset: pair
        });

        for (const trade of scheduledTrades) {
            // Normalize the scheduled time to minute precision
            const scheduledTime = new Date(trade.scheduledTime);
            scheduledTime.setSeconds(0, 0);
            
            // Activate if the normalized times match exactly
            if (scheduledTime.getTime() === candleTime.getTime()) {
                trade.status = "active";
                trade.entryPrice = entryPrice;
                trade.activationTimestamp = candleTime; 
                await trade.save();
                io.to(trade.userId.toString()).emit("trade_active", { trade: trade });
            }
        }
    } catch (err) {
        console.error("Error activating scheduled trades:", err);
    }
}

async function activatePendingTradesForPair(io, User, Trade, pair, candleTimestamp, entryPrice) {
    try {
        const pendings = await Trade.find({ status: "pending", asset: pair });
        for (const trade of pendings) {
            trade.status = "active";
            trade.entryPrice = entryPrice;
            // Record the timestamp when the trade became active (the start of the candle)
            trade.activationTimestamp = candleTimestamp; 
            await trade.save();
            io.to(trade.userId.toString()).emit("trade_active", { trade: trade });
        }
    } catch (err) {
        console.error("Error activating pending trades:", err);
    }
}

// --- FIXED SETTLEMENT LOGIC ---
async function settleActiveTradesForPair(io, User, Trade, pair, lastCompletedCandle) {
    try {
        const exitPrice = lastCompletedCandle.close;
        const completedCandleTime = new Date(lastCompletedCandle.timestamp);
        completedCandleTime.setSeconds(0, 0);
        
        const actives = await Trade.find({ status: "active", asset: pair });
        
        for (const trade of actives) {
            const activationTime = new Date(trade.activationTimestamp);
            activationTime.setSeconds(0, 0);
            
            // FIXED: Settle trades that were activated exactly at the completed candle's start time
            // This means: if trade opened at 23:07:00, it settles when 23:07 candle completes
            if (activationTime.getTime() === completedCandleTime.getTime()) {
                
                const win = (trade.direction === "UP" && exitPrice > trade.entryPrice) || 
                           (trade.direction === "DOWN" && exitPrice < trade.entryPrice);
                const tie = exitPrice === trade.entryPrice;
                const pnl = tie ? 0 : (win ? trade.amount * 0.9 : -trade.amount);

                trade.status = "closed";
                trade.exitPrice = exitPrice;
                trade.result = tie ? "TIE" : (win ? "WIN" : "LOSS");
                trade.pnl = pnl;
                trade.closeTime = new Date();
                await trade.save();

                const userAfter = await User.findByIdAndUpdate(
                    trade.userId,
                    {
                        $inc: {
                            balance: trade.amount + pnl,
                            totalTradeVolume: trade.amount
                        }
                    },
                    { new: true }
                );

                // Calculate today's P&L
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);

                const todayTrades = await Trade.find({
                    userId: trade.userId,
                    status: "closed",
                    closeTime: { $gte: today, $lt: tomorrow }
                });

                const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

                io.to(trade.userId.toString()).emit("trade_result", { 
                    trade: trade, 
                    balance: userAfter.balance,
                    todayPnl: parseFloat(todayPnl.toFixed(2))
                });
            }
        }
    } catch (err) {
        console.error("Error settling trades:", err);
    }
}

module.exports = { initialize };
