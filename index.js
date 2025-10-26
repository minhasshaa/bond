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
let adminRoutes;

try {
    // Check if Azure storage is configured
    const hasAzureConfig = process.env.AZURE_STORAGE_CONNECTION_STRING || 
                          (process.env.STORAGE_ACCOUNT_NAME && process.env.STORAGE_ACCOUNT_KEY);
    
    if (hasAzureConfig) {
        const { BlobServiceClient } = require('@azure/storage-blob');
        const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
        
        adminRoutes = require("./routes/admin")({
            blobServiceClient,
            KYC_CONTAINER_NAME: process.env.KYC_CONTAINER_NAME || 'kyc-documents',
            STORAGE_ACCOUNT_NAME: process.env.STORAGE_ACCOUNT_NAME,
            STORAGE_ACCOUNT_KEY: process.env.STORAGE_ACCOUNT_KEY
        });
        console.log('✅ Azure Storage configured for admin panel');
    } else {
        // Create admin routes without Azure support
        adminRoutes = require("./routes/admin")({});
        console.log('⚠️ Admin panel running without Azure Storage (KYC features disabled)');
    }
} catch (error) {
    console.log('⚠️ Azure Storage not available, admin KYC features disabled');
    // Fallback without Azure
    adminRoutes = require("./routes/admin")({});
}
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

// ------------------ ENHANCED WEBSOCKET MANAGEMENT ------------------
class WebSocketManager {
    constructor() {
        this.isStreaming = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.heartbeatInterval = null;
        this.connectionTimeout = null;
        this.lastMessageTime = Date.now();
        this.restPollingCleanup = null;
        this.wsCleanup = null;
    }

    startMarketDataStream() {
        if (this.isStreaming) return;
        
        console.log("⚡ Attempting Binance WebSocket connection...");
        
        // Clear any existing REST polling
        if (this.restPollingCleanup) {
            this.restPollingCleanup();
            this.restPollingCleanup = null;
        }

        this.connectionTimeout = setTimeout(() => {
            if (!this.isStreaming) {
                console.log("❌ WebSocket connection timeout, switching to REST polling");
                this.startRESTPolling();
            }
        }, 10000);
        
        const streams = TRADE_PAIRS.map(pair => `${pair.toLowerCase()}@trade`);
        
        try {
            // Store the cleanup function from binance.futuresSubscribe
            const cleanup = binance.futuresSubscribe(streams, (trade) => {
                try {
                    this.lastMessageTime = Date.now();
                    this.processTradeData(trade);
                } catch (streamErr) {
                    console.error(`❌ Stream processing error for ${trade.s}:`, streamErr.message);
                }
            }, {
                open: () => {
                    console.log('✅ Binance WebSocket connected successfully');
                    clearTimeout(this.connectionTimeout);
                    this.isStreaming = true;
                    this.reconnectAttempts = 0;
                    this.startHeartbeat();
                },
                close: (reason) => {
                    console.warn(`⚠️ WebSocket closed: ${reason}`);
                    this.handleDisconnection();
                },
                error: (err) => {
                    console.error('❌ WebSocket Error:', err.message);
                    this.handleDisconnection();
                }
            });

            // Store cleanup for later use
            this.wsCleanup = cleanup;

        } catch (err) {
            console.error('❌ WebSocket setup failed:', err.message);
            this.handleDisconnection();
        }
    }

    startHeartbeat() {
        // Clear existing heartbeat
        this.stopHeartbeat();
        
        // Send heartbeat every 30 seconds
        this.heartbeatInterval = setInterval(() => {
            const timeSinceLastMessage = Date.now() - this.lastMessageTime;
            
            if (timeSinceLastMessage > 45000) { // 45 seconds without data
                console.warn('⚠️ No WebSocket data for 45 seconds, reconnecting...');
                this.handleDisconnection();
                return;
            }
            
            // Binance WebSocket doesn't require explicit pings, but we can monitor connection
            if (this.isStreaming) {
                console.log('💓 WebSocket heartbeat - connection healthy');
            }
        }, 30000); // Check every 30 seconds
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    handleDisconnection() {
        this.isStreaming = false;
        this.stopHeartbeat();
        clearTimeout(this.connectionTimeout);
        
        // Clean up WebSocket connection
        if (this.wsCleanup && typeof this.wsCleanup === 'function') {
            try {
                this.wsCleanup();
            } catch (e) {
                console.error('Error cleaning up WebSocket:', e.message);
            }
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
            console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
            
            setTimeout(() => {
                this.reconnectAttempts++;
                this.startMarketDataStream();
            }, delay);
        } else {
            console.log('❌ Max reconnection attempts reached, switching to REST polling');
            this.startRESTPolling();
        }
    }

    processTradeData(trade) {
        const pair = trade.s;
        const price = parseFloat(trade.p);
        const md = marketData[pair];
        
        if (!md) return;
        
        const previousPrice = md.currentPrice;
        md.currentPrice = price;
        
        const now = new Date();
        const currentMinuteStart = new Date(now);
        currentMinuteStart.setSeconds(0, 0);
        currentMinuteStart.setMilliseconds(0);

        // Initialize currentCandle if needed
        if (!md.currentCandle) {
            md.currentCandle = this.createNewCandle(pair, currentMinuteStart, price);
        }
        
        const isNewMinute = md.currentCandle.timestamp.getTime() !== currentMinuteStart.getTime();

        if (isNewMinute) {
            this.completeCurrentCandle(md, pair, price);
            md.currentCandle = this.createNewCandle(pair, currentMinuteStart, price);
        } else {
            // Update current candle in real-time
            md.currentCandle.high = Math.max(md.currentCandle.high, price);
            md.currentCandle.low = Math.min(md.currentCandle.low, price);
            md.currentCandle.close = price;
        }

        // Emit real-time data
        this.emitMarketData(md, pair, price, now);
    }

    createNewCandle(pair, timestamp, price) {
        return { 
            asset: pair, 
            timestamp: timestamp, 
            open: price, 
            high: price, 
            low: price, 
            close: price 
        };
    }

    completeCurrentCandle(md, pair, price) {
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
    }

    emitMarketData(md, pair, price, timestamp) {
        const chartData = {
            asset: pair, 
            candles: [...md.candles],
            currentCandle: md.currentCandle,
            currentPrice: price,
            timestamp: timestamp.getTime()
        };

        io.emit("market_data", chartData);
    }

    startRESTPolling() {
        if (this.isStreaming) return;
        
        console.log("🔄 Starting REST API polling...");
        
        const pollInterval = setInterval(async () => {
            try {
                const prices = await binance.futuresPrices();
                const now = new Date();
                
                for (const pair of TRADE_PAIRS) {
                    const price = parseFloat(prices[pair]);
                    if (!price || !marketData[pair]) continue;
                    
                    const md = marketData[pair];
                    const previousPrice = md.currentPrice;
                    md.currentPrice = price;
                    
                    const currentMinuteStart = new Date(now);
                    currentMinuteStart.setSeconds(0, 0);
                    currentMinuteStart.setMilliseconds(0);

                    // Initialize currentCandle if needed
                    if (!md.currentCandle) {
                        md.currentCandle = this.createNewCandle(pair, currentMinuteStart, price);
                    }
                    
                    const isNewMinute = md.currentCandle.timestamp.getTime() !== currentMinuteStart.getTime();

                    if (isNewMinute) {
                        this.completeCurrentCandle(md, pair, price);
                        md.currentCandle = this.createNewCandle(pair, currentMinuteStart, price);
                    } else {
                        // Update current candle in real-time
                        md.currentCandle.high = Math.max(md.currentCandle.high, price);
                        md.currentCandle.low = Math.min(md.currentCandle.low, price);
                        md.currentCandle.close = price;
                    }

                    // Emit market data
                    this.emitMarketData(md, pair, price, now);
                }
                
            } catch (err) {
                console.error('❌ REST polling error:', err.message);
            }
        }, 2000); // Poll every 2 seconds

        // Return cleanup function
        this.restPollingCleanup = () => {
            clearInterval(pollInterval);
            console.log('🔄 REST API polling stopped');
        };
    }

    // Public method to manually restart WebSocket
    restartWebSocket() {
        console.log('🔄 Manual WebSocket restart requested');
        this.reconnectAttempts = 0;
        this.handleDisconnection();
    }
}

// Create global WebSocket manager instance
const wsManager = new WebSocketManager();

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

// Add WebSocket restart endpoint
app.post("/api/restart-websocket", (req, res) => {
    wsManager.restartWebSocket();
    res.json({ success: true, message: "WebSocket restart initiated" });
});

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
            const klines = await binance.futuresCandles(pair, '1m', { limit: 200 });
            
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
    
    if (Object.keys(payloadTrading).length > 0) {
        io.emit("price_update", payloadTrading);           
        io.emit("dashboard_price_update", payloadDashboard);
    }
}, 1000);

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
  wsManager.startMarketDataStream(); // Use the enhanced WebSocket manager

  const tradeModule = require("./trade");
  if (typeof tradeModule.initialize === "function") {
    const Trade = mongoose.model('Trade');
    const User = mongoose.model('User');
    tradeModule.initialize(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
  } else if (typeof tradeModule === "function") {
    tradeModule(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
  } else {
    console.error("Trade module export not recognized.");
  }
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
server.listen(PORT, () => console.log(`✅ Server is running and listening on port ${PORT}`));

// Export for testing or external use
module.exports = { app, wsManager, marketData };
