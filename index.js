// index.js
// ------------------ DEPENDENCIES ------------------
require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const Binance = require("node-binance-api");
const jwt = require('jsonwebtoken'); 

// ------------------ CONFIG & CONSTANTS ------------------
const requiredEnvVars = ['MONGO_URI', 'JWT_SECRET'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
    process.exit(1);
}

const TRADE_PAIRS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','MATICUSDT'
];
module.exports.TRADE_PAIRS = TRADE_PAIRS;

// admin override flags
const candleOverride = {};
TRADE_PAIRS.forEach(pair => { candleOverride[pair] = null; });
module.exports.candleOverride = candleOverride;

// ------------------ MODELS & ROUTES ------------------
const User = require("./models/User");
const Trade = require("./models/Trade");
const Candle = require("./models/candles");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposit");
const adminRoutes = require("./routes/admin");
const withdrawRoutes = require("./routes/withdraw");

// ------------------ APP + SERVER + IO ------------------
const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: process.env.CLIENT_URL || "*",
        methods: ["GET", "POST"],
        credentials: true
    }
}); 

const marketData = {};
TRADE_PAIRS.forEach(pair => {
  marketData[pair] = { currentPrice: 0, candles: [], currentCandle: null };
});
module.exports.marketData = marketData;
app.set('marketData', marketData);

// ------------------ BINANCE CLIENT ------------------
const binance = new Binance().options({});

// ------------------ MIDDLEWARE ------------------
app.use(cors({
    origin: process.env.CLIENT_URL || "*",
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/deposit", depositRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdraw", withdrawRoutes);

// ----- DASHBOARD DATA FUNCTIONS START -----
async function getDashboardData(userId) {
    const user = await User.findById(userId).select('username balance');
    if (!user) {
        throw new Error('User not found.');
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const recentTrades = await Trade.find({ 
        userId: userId, 
        status: 'closed',
        closeTime: { $gte: startOfToday } 
    });

    const todayPnl = recentTrades.reduce((total, trade) => total + (trade.pnl || 0), 0);

    const assets = TRADE_PAIRS;
    const marketInfo = assets.map(pair => {
        const data = marketData[pair];
        if (!data || typeof data.currentPrice !== 'number') return null;

        const lastCandle = (Array.isArray(data.candles) && data.candles[data.candles.length - 1]) || data.currentCandle;
        if (!lastCandle || typeof lastCandle.open !== 'number' || lastCandle.open === 0) {
            return { name: pair.replace('USDT', ''), ticker: `${pair.replace('USDT', '')}/USD`, price: data.currentPrice || 0, change: 0, candles: data.candles };
        }

        const change = ((data.currentPrice - lastCandle.open) / lastCandle.open) * 100;

        return {
            name: pair.replace('USDT', ''),
            ticker: `${pair.replace('USDT', '')}/USD`,
            price: data.currentPrice,
            change: parseFloat(change.toFixed(2)),
            candles: data.candles
        };
    }).filter(Boolean);

    return {
        username: user.username,
        balance: user.balance,
        todayPnl: parseFloat(todayPnl.toFixed(2)),
        recentTrades: [], 
        assets: marketInfo
    };
}

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error("Authentication Error: Token not provided."));
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.decoded = decoded; 
        next();
    } catch (ex) {
        return next(new Error("Authentication Error: Invalid token."));
    }
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    if (socket.decoded && socket.decoded.id) {
        socket.join(socket.decoded.id);
        console.log(`Socket ${socket.id} (dashboard) joined room ${socket.decoded.id}`);
    }

    socket.on('request_dashboard_data', async () => {
        try {
            const userId = socket.decoded.id;
            const dashboardData = await getDashboardData(userId);
            socket.emit('dashboard_data', { success: true, data: dashboardData });
        } catch (error) {
            console.error('Socket error fetching dashboard data:', error.message);
            socket.emit('dashboard_data', { success: false, message: 'Could not fetch dashboard data.' });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});
// ----- DASHBOARD DATA FUNCTIONS END -----

// ------------------ CANDLE / MARKET DATA LOGIC ------------------

async function initializeMarketData() {
    console.log("📈 Initializing market data from Binance...");
    for (const pair of TRADE_PAIRS) {
        try {
            const klines = await binance.futancesCandles(pair, '1m', { limit: 200 });
            
            if (!Array.isArray(klines) || klines.length < 5) { 
                 console.warn(`⚠️ Historical load failed for ${pair}. Starting clean.`);
                 marketData[pair].candles = []; 
                 marketData[pair].currentPrice = 0;
                 marketData[pair].currentCandle = null; 
                 continue; 
            }

            marketData[pair].candles = klines.map(k => ({
                asset: pair,
                timestamp: new Date(k[0]),
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
            }));
            const lastCandle = marketData[pair].candles[marketData[pair].candles.length - 1];
            marketData[pair].currentPrice = lastCandle.close;
            
            marketData[pair].currentCandle = {
                asset: pair,
                timestamp: new Date(lastCandle.timestamp.getTime() + 60000),
                open: lastCandle.close,
                high: lastCandle.close,
                low: lastCandle.close,
                close: lastCandle.close
            };
            console.log(`✅ Loaded ${marketData[pair].candles.length} historical candles for ${pair}.`);
        } catch (err) {
            console.error(`❌ Fatal error in initial load for ${pair}:`, err.message);
            marketData[pair].candles = []; 
            marketData[pair].currentPrice = 0;
            marketData[pair].currentCandle = null;
        }
    }
}

let isStreaming = false;

// ⭐ FIXED: Market data stream with proper chart updates
function startMarketDataStream() {
    if (isStreaming) return;
    isStreaming = true;
    
    console.log("⚡ Starting Binance WebSocket stream...");
    const streams = TRADE_PAIRS.map(pair => `${pair.toLowerCase()}@trade`);
    
    binance.futuresSubscribe(streams, (trade) => {
        try {
            const pair = trade.s;
            const price = parseFloat(trade.p);
            const md = marketData[pair];
            
            if (!md) return;
            
            // Update current price
            md.currentPrice = price;
            
            const now = new Date();
            const currentMinuteStart = new Date(now);
            currentMinuteStart.setSeconds(0, 0);
            currentMinuteStart.setMilliseconds(0);

            // Initialize currentCandle if needed
            if (!md.currentCandle) {
                md.currentCandle = { 
                    asset: pair, 
                    timestamp: currentMinuteStart, 
                    open: price, 
                    high: price, 
                    low: price, 
                    close: price 
                };
            }
            
            const isNewMinute = md.currentCandle.timestamp.getTime() !== currentMinuteStart.getTime();

            if (isNewMinute) {
                // Complete the current candle
                const completed = { ...md.currentCandle, close: price };
                
                // Handle candle override if any
                const override = candleOverride[pair];
                if (override) {
                    const openP = completed.open;
                    const priceChange = openP * 0.00015 * (Math.random() + 0.5);
                    if (override === 'up') {
                        completed.close = openP + priceChange;
                        completed.high = Math.max(completed.high, completed.close);
                    } else {
                        completed.close = openP - priceChange;
                        completed.low = Math.min(completed.low, completed.close);
                    }
                    console.log(`🔴 OVERRIDE: Forcing ${pair} to CLOSE ${override.toUpperCase()} => ${completed.close.toFixed(6)}`);
                    candleOverride[pair] = null;
                }
                
                // Save completed candle
                if (completed.open > 0 && completed.close > 0) {
                    md.candles.push(completed);
                    if (md.candles.length > 200) md.candles.shift();
                    
                    // Save to database
                    Candle.updateOne({ asset: pair, timestamp: completed.timestamp }, { $set: completed }, { upsert: true }).catch(err => {
                        console.error(`DB Error saving completed candle for ${pair}:`, err.message);
                    });
                }
                
                // Start new candle
                md.currentCandle = { 
                    asset: pair, 
                    timestamp: currentMinuteStart, 
                    open: price, 
                    high: price, 
                    low: price, 
                    close: price 
                };
            } else {
                // Update current candle
                md.currentCandle.high = Math.max(md.currentCandle.high, price);
                md.currentCandle.low = Math.min(md.currentCandle.low, price);
                md.currentCandle.close = price;
            }

            // ⭐ FIXED: Emit complete market data for charts
            io.emit("market_data", { 
                asset: pair, 
                candles: md.candles,
                currentCandle: md.currentCandle,
                currentPrice: price,
                timestamp: now.getTime()
            });
            
        } catch (streamErr) {
            console.error(`❌ Stream processing error for ${trade.s}:`, streamErr.message);
        }
    }, {
        open: () => console.log('✅ Binance WebSocket connection opened.'),
        close: (reason) => {
            isStreaming = false;
            console.warn(`⚠️ Binance WebSocket closed. Reason: ${reason}. Attempting to restart in 5s...`);
            setTimeout(startMarketDataStream, 5000);
        },
        error: (err) => {
            console.error('❌ Binance WebSocket Error:', err.message);
        }
    });
}

// ------------------ DASHBOARD PRICE EMITTER ------------------
setInterval(() => {
    const now = new Date();
    const secondsUntilNextMinute = 60 - now.getSeconds();
    const payloadDashboard = {};
    const payloadTrading = {};

    for (const pair of TRADE_PAIRS) {
        const md = marketData[pair];
        if (!md || md.currentPrice === 0) continue; 
        
        const lastCandle = (md.candles && md.candles.length > 0) ? md.candles[md.candles.length - 1] : md.currentCandle;
        let change = 0;
        if (lastCandle && lastCandle.open !== 0) {
            change = ((md.currentPrice - lastCandle.open) / lastCandle.open) * 100;
        }

        const tickerForClient = `${pair.replace('USDT', '')}/USD`;
        payloadDashboard[tickerForClient] = {
            price: md.currentPrice,
            change: parseFloat(change.toFixed(2)),
            countdown: secondsUntilNextMinute
        };

        payloadTrading[pair] = {
            price: md.currentPrice,
            countdown: secondsUntilNextMinute,
            timestamp: now.getTime()
        };
    }
    
    if (isStreaming && Object.keys(payloadTrading).length > 0) {
        io.emit("price_update", payloadTrading);           
        io.emit("dashboard_price_update", payloadDashboard);
    }
}, 1000);

// ------------------ TRADE MODULE HANDLING ------------------
function initializeTradeHandlers() {
    console.log("🔄 Initializing trade handlers...");
    
    // Trade event handlers
    io.on('connection', (socket) => {
        // Existing dashboard handlers above...
        
        // Trade handlers
        socket.on('trade', async (tradeData) => {
            try {
                console.log('📈 Trade request:', tradeData);
                
                // Create trade record
                const trade = new Trade({
                    userId: socket.decoded.id,
                    asset: tradeData.asset,
                    direction: tradeData.direction,
                    amount: tradeData.amount,
                    openingPrice: tradeData.openingPrice,
                    status: 'pending'
                });
                
                await trade.save();
                
                // Update user balance (deduct trade amount)
                await User.findByIdAndUpdate(socket.decoded.id, {
                    $inc: { balance: -tradeData.amount }
                });
                
                const user = await User.findById(socket.decoded.id);
                
                socket.emit('trade_pending', { trade, balance: user.balance });
                
                // Simulate trade processing
                setTimeout(() => {
                    trade.status = 'active';
                    trade.save();
                    
                    socket.emit('trade_active', { trade });
                    
                    // Simulate trade result after 1 minute
                    setTimeout(async () => {
                        const currentPrice = marketData[tradeData.asset]?.currentPrice || tradeData.openingPrice;
                        const isWin = tradeData.direction === 'UP' ? 
                            currentPrice > tradeData.openingPrice : 
                            currentPrice < tradeData.openingPrice;
                        
                        trade.status = 'closed';
                        trade.result = isWin ? 'WIN' : 'LOSS';
                        trade.closingPrice = currentPrice;
                        trade.pnl = isWin ? tradeData.amount * 0.8 : -tradeData.amount;
                        trade.closeTime = new Date();
                        
                        await trade.save();
                        
                        // Update user balance with P&L
                        await User.findByIdAndUpdate(socket.decoded.id, {
                            $inc: { balance: trade.pnl + tradeData.amount } // Return original amount + P&L
                        });
                        
                        const updatedUser = await User.findById(socket.decoded.id);
                        
                        socket.emit('trade_result', { 
                            trade, 
                            balance: updatedUser.balance 
                        });
                        
                    }, 60000); // 1 minute
                    
                }, 2000); // 2 seconds for "pending" state
                
            } catch (error) {
                console.error('❌ Trade error:', error);
                socket.emit('error', { message: 'Trade failed: ' + error.message });
            }
        });

        socket.on('schedule_trade', async (tradeData) => {
            try {
                console.log('⏰ Scheduled trade:', tradeData);
                
                const scheduledTime = new Date();
                const [hours, minutes] = tradeData.scheduledTime.split(':');
                scheduledTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
                
                // Deduct amount immediately for scheduled trades
                await User.findByIdAndUpdate(socket.decoded.id, {
                    $inc: { balance: -tradeData.amount }
                });
                
                const trade = new Trade({
                    userId: socket.decoded.id,
                    asset: tradeData.asset,
                    direction: tradeData.direction,
                    amount: tradeData.amount,
                    openingPrice: tradeData.openingPrice,
                    status: 'scheduled',
                    scheduledTime: scheduledTime
                });
                
                await trade.save();
                
                const user = await User.findById(socket.decoded.id);
                
                socket.emit('trade_scheduled', { trade, balance: user.balance });
                
                // Schedule the trade execution
                const timeUntilExecution = scheduledTime.getTime() - Date.now();
                if (timeUntilExecution > 0) {
                    setTimeout(async () => {
                        try {
                            trade.status = 'active';
                            await trade.save();
                            
                            socket.emit('trade_active', { trade });
                            
                            // Simulate trade result after 1 minute
                            setTimeout(async () => {
                                const currentPrice = marketData[tradeData.asset]?.currentPrice || tradeData.openingPrice;
                                const isWin = tradeData.direction === 'UP' ? 
                                    currentPrice > tradeData.openingPrice : 
                                    currentPrice < tradeData.openingPrice;
                                
                                trade.status = 'closed';
                                trade.result = isWin ? 'WIN' : 'LOSS';
                                trade.closingPrice = currentPrice;
                                trade.pnl = isWin ? tradeData.amount * 0.8 : -tradeData.amount;
                                trade.closeTime = new Date();
                                
                                await trade.save();
                                
                                // Update user balance with P&L
                                await User.findByIdAndUpdate(socket.decoded.id, {
                                    $inc: { balance: trade.pnl + tradeData.amount }
                                });
                                
                                const updatedUser = await User.findById(socket.decoded.id);
                                
                                socket.emit('trade_result', { 
                                    trade, 
                                    balance: updatedUser.balance 
                                });
                                
                            }, 60000);
                            
                        } catch (error) {
                            console.error('❌ Scheduled trade execution error:', error);
                            // Refund user if scheduled trade fails
                            await User.findByIdAndUpdate(socket.decoded.id, {
                                $inc: { balance: tradeData.amount }
                            });
                            socket.emit('error', { message: 'Scheduled trade execution failed' });
                        }
                    }, timeUntilExecution);
                }
                
            } catch (error) {
                console.error('❌ Scheduled trade error:', error);
                socket.emit('error', { message: 'Scheduled trade failed' });
            }
        });

        socket.on('cancel_trade', async (data) => {
            try {
                const trade = await Trade.findById(data.tradeId);
                if (trade && trade.userId.toString() === socket.decoded.id) {
                    // Refund the amount if trade was pending/scheduled
                    if (trade.status === 'pending' || trade.status === 'scheduled') {
                        await User.findByIdAndUpdate(socket.decoded.id, {
                            $inc: { balance: trade.amount }
                        });
                    }
                    
                    trade.status = 'cancelled';
                    await trade.save();
                    
                    const user = await User.findById(socket.decoded.id);
                    socket.emit('trade_cancelled', { tradeId: data.tradeId, balance: user.balance });
                }
            } catch (error) {
                console.error('❌ Cancel trade error:', error);
                socket.emit('error', { message: 'Cancel trade failed' });
            }
        });

        socket.on('copy_trade', async (data) => {
            try {
                console.log('📋 Copy trade request:', data);
                // Implement copy trade logic here
                socket.emit('copy_trade_success', { asset: data.asset });
            } catch (error) {
                console.error('❌ Copy trade error:', error);
                socket.emit('error', { message: 'Copy trade failed' });
            }
        });

        socket.on('request_copy_trades', () => {
            // Send available copy trades
            socket.emit('copy_trades_available', {
                copyTrades: [],
                message: 'No copy trades available'
            });
        });
    });
}

// ------------------ DB + STARTUP ------------------
mongoose.connect(process.env.MONGO_URI, { 
    useNewUrlParser: true, 
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
}).catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
});

const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.on("disconnected", () => console.log("⚠️ MongoDB disconnected"));
db.on("reconnected", () => console.log("✅ MongoDB reconnected"));

db.once("open", async () => {
  console.log("✅ Connected to MongoDB");

  try {
    const TradeModel = mongoose.model('Trade');
    const UserModel = mongoose.model('User');

    const tradeUpdateResult = await TradeModel.updateMany(
      { 
        status: { $ne: 'closed' },
        $or: [
          { activationTimestamp: { $not: { $type: 9 } } }, 
          { activationTimestamp: { $exists: false } }, 
          { activationTimestamp: null } 
        ]
      },
      { 
        $set: { 
          status: 'closed', 
          closeTime: new Date(),
          pnl: 0 
        } 
      }
    );
    console.log(`🧹 Safely closed ${tradeUpdateResult.modifiedCount} corrupted trade records.`);

    const userUpdateResult = await UserModel.updateMany(
      { $or: [{ createdAt: { $not: { $type: 9 } } }, { createdAt: { $exists: false } }, { createdAt: null }] },
      { $set: { createdAt: new Date() } }
    );
    console.log(`🧹 Safely fixed ${userUpdateResult.modifiedCount} corrupted user date records.`);

  } catch (error) {
    console.error("Warning: Pre-boot database cleanup failed:", error.message);
  }

  await initializeMarketData();
  startMarketDataStream(); 
  
  // ⭐ FIXED: Initialize trade handlers directly instead of importing external module
  initializeTradeHandlers();
});

// ------------------ CATCH-ALL / STATIC SERVE ------------------
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'API endpoint not found.' });
  const filePath = path.join(__dirname, 'public', req.path);
  if (req.path.includes('..')) return res.status(403).send('Forbidden');
  res.sendFile(filePath, (err) => {
    if (err) res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  });
});

// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 5000;

// ⭐ FIXED: Port conflict handling
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is running and listening on port ${PORT}`);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Trying port ${Number(PORT) + 1}...`);
        server.listen(Number(PORT) + 1, '0.0.0.0', () => {
            console.log(`✅ Server is running on alternative port ${Number(PORT) + 1}`);
        });
    } else {
        console.error('❌ Server error:', err);
        process.exit(1);
    }
});
