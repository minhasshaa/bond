// trade.js - COMPLETE VERSION WITH AUTOMATIC TRADE ACTIVATION FIXES
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminCopyTrade = require('./models/AdminCopyTrade');

// Global reference for marketData
let globalMarketData = {};
const POLL_INTERVAL_MS = 1000;

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

        console.log(`Copy trade ${copyTradeId} executed`);

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
                console.error(`Error executing copy trade ${copyTrade._id}:`, innerErr);
            }
        }
    } catch (error) {
        console.error('Copy trade cleanup error:', error);
    }
}

// --- Volume-based Direction Logic ---
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

// --- Trade Activation Functions ---
async function activateScheduledTradesForPair(io, Trade, pair, candleTimestamp, entryPrice) {
    try {
        const candleTime = new Date(candleTimestamp);
        candleTime.setSeconds(0, 0);

        const scheduledTrades = await Trade.find({ 
            status: "scheduled", 
            asset: pair, 
            scheduledTime: { $lte: candleTime } 
        });

        console.log(`🔄 Found ${scheduledTrades.length} scheduled trades to activate for ${pair}`);

        for (const trade of scheduledTrades) {
            try {
                console.log(`🔄 Activating scheduled trade ${trade._id} for ${pair}`);
                
                trade.status = "active";
                trade.entryPrice = entryPrice;
                trade.activationTimestamp = new Date();
                await trade.save();
                
                // ✅ CRITICAL FIX: Emit to ALL clients in the user's room
                io.to(trade.userId.toString()).emit("trade_active", { trade: trade });
                console.log(`✅ Emitted trade_active for user ${trade.userId}, trade ${trade._id}`);
                
            } catch (innerErr) {
                console.error(`Error activating scheduled trade ${trade._id}:`, innerErr);
            }
        }
    } catch (err) {
        console.error("Error finding scheduled trades:", err);
    }
}

async function activatePendingTradesForPair(io, User, Trade, pair, entryPrice) {
    try {
        const pendingTrades = await Trade.find({ status: "pending", asset: pair });
        
        console.log(`🔄 Found ${pendingTrades.length} pending trades to activate for ${pair}`);

        for (const trade of pendingTrades) {
            try {
                console.log(`🔄 Activating pending trade ${trade._id} for ${pair}`);
                
                trade.status = "active";
                trade.entryPrice = entryPrice;
                trade.activationTimestamp = new Date();
                await trade.save();
                
                // ✅ CRITICAL FIX: Emit to ALL clients in the user's room
                io.to(trade.userId.toString()).emit("trade_active", { trade: trade });
                console.log(`✅ Emitted trade_active for user ${trade.userId}, trade ${trade._id}`);
                
            } catch (innerErr) {
                console.error(`Error activating pending trade ${trade._id}:`, innerErr);
            }
        }
    } catch (err) {
        console.error("Error finding pending trades:", err);
    }
}

// --- Trade Settlement Function ---
async function settleActiveTradesForPair(io, User, Trade, pair, exitPrice) {
    try {
        const activeTrades = await Trade.find({ 
            status: "active", 
            asset: pair,
            activationTimestamp: { $exists: true, $lte: new Date(Date.now() - 60000) } // At least 1 minute old
        });
        
        console.log(`💰 Found ${activeTrades.length} active trades to settle for ${pair}`);

        for (const trade of activeTrades) {
            try {
                const win = (trade.direction === "UP" && exitPrice > trade.entryPrice) || 
                           (trade.direction === "DOWN" && exitPrice < trade.entryPrice);
                
                // Only process if there's a clear win/loss (not tie)
                if (exitPrice !== trade.entryPrice) {
                    const pnl = win ? trade.amount * 0.9 : -trade.amount;

                    trade.status = "closed";
                    trade.exitPrice = exitPrice;
                    trade.result = win ? "WIN" : "LOSS";
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

                    console.log(`💰 Trade settled for user ${trade.userId}: ${trade.result} P&L $${pnl}`);
                }
            } catch (innerErr) {
                console.error(`Error settling trade ${trade._id}:`, innerErr);
            }
        }
    } catch (err) {
        console.error("Error finding active trades:", err);
    }
}

// --- Trade Monitoring Logic ---
async function runTradeMonitor(io, User, Trade, TRADE_PAIRS) {
    const lastProcessedCompletedCandleTs = {};
    const lastProcessedActivationTs = {};
    const lastCopyTradeCleanup = {};

    setInterval(async () => {
        try {
            for (const pair of TRADE_PAIRS) {
                const md = globalMarketData[pair];
                if (!md) continue;

                // 1. ACTIVATE SCHEDULED/PENDING TRADES (when a NEW candle starts)
                if (md.currentCandle) {
                    const currentCandleStartTime = new Date(md.currentCandle.timestamp);
                    const activationTs = currentCandleStartTime.getTime();

                    // ✅ CRITICAL FIX: Check if this is a new minute and we haven't processed it yet
                    if (!lastProcessedActivationTs[pair] || lastProcessedActivationTs[pair] < activationTs) {
                        console.log(`🕒 New candle detected for ${pair}, activating trades...`);
                        
                        await activateScheduledTradesForPair(io, Trade, pair, md.currentCandle.timestamp, md.currentCandle.open);
                        await activatePendingTradesForPair(io, User, Trade, pair, md.currentCandle.open);
                        
                        lastProcessedActivationTs[pair] = activationTs;
                        console.log(`✅ Trade activation completed for ${pair}`);
                    }
                }

                // 2. SETTLE ACTIVE TRADES (when a candle is complete)
                if (md.candles?.length > 0) {
                    const lastCompleted = md.candles[md.candles.length - 1];
                    const lastCompletedTs = new Date(lastCompleted.timestamp).getTime();
                    
                    // Only settle once per unique candle
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < lastCompletedTs) {
                        const candleAge = Date.now() - lastCompletedTs;
                        
                        // Only process candles that are completed (at least 5 seconds old)
                        if (candleAge > 5000) { 
                            console.log(`💰 Settling trades for completed candle on ${pair}`);
                            await settleActiveTradesForPair(io, User, Trade, pair, lastCompleted.close);
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
        } catch (err) {
            console.error("Trade monitor error:", err);
        }
    }, POLL_INTERVAL_MS);
}

// --- Main Initialization Function ---
async function initialize(io, User, Trade, marketData, TRADE_PAIRS) {
    globalMarketData = marketData;

    // Socket authentication
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

    // Forward market data to trading clients
    const mainServerNamespace = io.of("/");
    mainServerNamespace.on('connection', (mainSocket) => {
        mainSocket.on('market_data', (data) => {
            io.emit('market_data', data);
        });

        mainSocket.on('price_update', (data) => {
            io.emit('price_update', data);
        });
    });

    // Start trade monitoring
    console.log("🔄 Starting trade monitor with automatic activation...");
    runTradeMonitor(io, User, Trade, TRADE_PAIRS);

    // Socket event handlers
    io.on("connection", async (socket) => {
        try {
            const userId = socket.decoded.id;
            const user = await User.findById(userId);
            if (!user) return socket.disconnect();
            
            socket.join(user._id.toString());
            console.log(`🔗 User ${userId} connected to trading`);

            // Send initial data
            const userTrades = await Trade.find({ userId: user._id }).sort({ timestamp: -1 }).limit(50);
            socket.emit("init", { 
                balance: user.balance, 
                tradeHistory: userTrades,
                marketData: globalMarketData
            });

            // Forward real-time data to client
            socket.on('market_data', (data) => {
                socket.emit('market_data', data);
            });

            socket.on('price_update', (data) => {
                socket.emit('price_update', data);
            });

            // --- TRADE PLACEMENT ---
            socket.on("trade", async (data) => {
                try {
                    const { asset, direction, amount } = data;
                    console.log(`🎯 New trade request from user ${userId}:`, { asset, direction, amount });
                    
                    if (!TRADE_PAIRS.includes(asset)) {
                        return socket.emit("error", { message: "Invalid asset." });
                    }
                    if (!["UP", "DOWN"].includes(direction)) {
                        return socket.emit("error", { message: "Invalid direction." });
                    }

                    // Check for existing active trade
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

                    // Get volume-based direction
                    const finalDirection = await getTradeDirectionBasedOnVolume(asset, direction);

                    // Deduct balance
                    freshUser.balance -= tradeAmount;
                    await freshUser.save();

                    // Create trade
                    const trade = new Trade({
                        userId: user._id,
                        amount: tradeAmount,
                        direction: finalDirection, 
                        asset,
                        status: "pending", 
                        timestamp: new Date()
                    });
                    await trade.save();

                    console.log(`✅ Trade created for user ${userId}: ${trade._id}`);

                    io.to(user._id.toString()).emit("trade_pending", { 
                        trade: trade, 
                        balance: freshUser.balance 
                    });

                } catch (err) {
                    console.error("Trade placement error:", err);
                    socket.emit("error", { message: "Could not place trade." });
                }
            });

            // --- COPY TRADE ---
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

                    // Check for existing trade
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

                    // Check if already copied
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

                    // Create scheduled trade
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

                    // Update balances
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

                    // Calculate time until execution
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

            // --- SCHEDULED TRADE ---
            socket.on("schedule_trade", async (data) => {
                try {
                    const { asset, direction, scheduledTime, amount } = data;
                    if (!TRADE_PAIRS.includes(asset)) return socket.emit("error", { message: "Invalid asset." });
                    if (!["UP", "DOWN"].includes(direction)) return socket.emit("error", { message: "Invalid direction." });

                    // Check for existing trade
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

                    // Get volume-based direction
                    const finalDirection = await getTradeDirectionBasedOnVolume(asset, direction);

                    // Parse scheduled time
                    const serverNowUTC = new Date();
                    const [hour, minute] = scheduledTime.split(":").map(Number);
                    const userScheduledTimeToday = new Date(serverNowUTC);
                    userScheduledTimeToday.setUTCHours(hour, minute, 0, 0); 

                    // Validate time (next 10 minutes only)
                    const tenMinutesFromNow = new Date(serverNowUTC.getTime() + (10 * 60 * 1000));
                    if (userScheduledTimeToday <= serverNowUTC || userScheduledTimeToday > tenMinutesFromNow) {
                        return socket.emit("error", { message: "Please select a time in the next 10 minutes." });
                    }

                    const finalScheduleDtUTC = userScheduledTimeToday; 
                    finalScheduleDtUTC.setSeconds(0, 0); 

                    // Deduct balance and create trade
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

                    io.to(user._id.toString()).emit("trade_scheduled", { 
                        trade: trade, 
                        balance: freshUser.balance 
                    });

                } catch (err) {
                    console.error("Error in schedule_trade:", err);
                    socket.emit("error", { message: "Could not schedule trade." });
                }
            });

            // --- CANCEL TRADE ---
            socket.on("cancel_trade", async (data) => {
                try {
                    const trade = await Trade.findOne({
                        _id: data.tradeId,
                        userId: user._id,
                        status: { $in: ["pending", "scheduled"] }
                    });
                    
                    if (!trade) return socket.emit("error", { message: "Trade not found or cannot be cancelled." });

                    // Refund balance
                    const freshUser = await User.findById(user._id);
                    freshUser.balance += trade.amount;
                    await freshUser.save();

                    // Cancel trade
                    trade.status = "cancelled";
                    await trade.save();
                    
                    io.to(user._id.toString()).emit("trade_cancelled", { 
                        tradeId: trade._id, 
                        balance: freshUser.balance 
                    });
                } catch (err) {
                    socket.emit("error", { message: "Could not cancel trade." });
                }
            });

            // --- TRADE ACTIVE EVENT HANDLER ---
            socket.on("trade_active", (data) => {
                console.log(`✅ Received trade_active event for user ${userId}`);
                // This will be handled by the updateTradeStatus function in the frontend
            });

            socket.on("disconnect", () => {
                console.log(`🔌 User ${userId} disconnected from trading`);
            });

        } catch (err) {
            console.error("Socket connection error:", err);
            socket.disconnect();
        }
    });
}

module.exports = { initialize };
