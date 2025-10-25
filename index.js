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
// >>> START KYC ADDITIONS <<<
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
// >>> END KYC ADDITIONS <<<

// ------------------ CONFIG & CONSTANTS ------------------
const TRADE_PAIRS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','MATICUSDT'
];
module.exports.TRADE_PAIRS = TRADE_PAIRS;

// admin override flags (kept in main server since candle generator uses them)
const candleOverride = {};
TRADE_PAIRS.forEach(pair => { candleOverride[pair] = null; });
module.exports.candleOverride = candleOverride;

// >>> START AZURE CONFIGURATION <<<
const STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const KYC_CONTAINER_NAME = process.env.KYC_CONTAINER_NAME || 'id-document-uploads';

let blobServiceClient = null;
if (STORAGE_ACCOUNT_NAME && STORAGE_ACCOUNT_KEY) {
    const sharedKeyCredential = new StorageSharedKeyCredential(
        STORAGE_ACCOUNT_NAME,
        STORAGE_ACCOUNT_KEY
    );
    blobServiceClient = new BlobServiceClient(
        `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
        sharedKeyCredential
    );
    console.log("✅ Azure Blob Storage Client Initialized.");
} else {
    console.warn("⚠️ WARNING: Azure Storage credentials not found. KYC upload will be disabled.");
}
// >>> END AZURE CONFIGURATION <<<

// ------------------ MODELS & ROUTES ------------------
const User = require("./models/User");
const Trade = require("./models/Trade");
const Candle = require("./models/candles");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposit");
const adminRoutes = require("./routes/admin");
const withdrawRoutes = require("./routes/withdraw");
// >>> START KYC ADDITION <<<
const kycRoutes = require("./routes/kyc"); 
// >>> END KYC ADDITION <<<

// ------------------ APP + SERVER + IO ------------------
const app = express();
const server = http.createServer(app);
// FIX: Removed Socket.IO CORS
const io = socketIo(server); 

const marketData = {};
TRADE_PAIRS.forEach(pair => {
  marketData[pair] = { currentPrice: 0, candles: [], currentCandle: null };
});
module.exports.marketData = marketData;
app.set('marketData', marketData);

// ------------------ BINANCE CLIENT ------------------
// Keeping options empty since you stated you aren't using keys
const binance = new Binance().options({});

// ------------------ MIDDLEWARE ------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/deposit", depositRoutes);

app.use("/api/admin", adminRoutes({ blobServiceClient, KYC_CONTAINER_NAME, STORAGE_ACCOUNT_NAME, STORAGE_ACCOUNT_KEY }));

app.use("/api/withdraw", withdrawRoutes);

// >>> START KYC ROUTE REGISTRATION <<<
app.use("/api/kyc", kycRoutes({ blobServiceClient, KYC_CONTAINER_NAME }));
// >>> END KYC ROUTE REGISTRATION <<<

// ----- DASHBOARD DATA FUNCTIONS START (UNCHANGED) -----
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
            
            // FIX: Check if klines is an array to prevent "klines.map is not a function" crash
            if (!Array.isArray(klines) || klines.length === 0) {
                 console.error(`❌ Received invalid or empty response for ${pair}. Data initialization skipped.`);
                 // Ensure initial marketData structure is clean
                 marketData[pair].candles = []; 
                 marketData[pair].currentPrice = 0;
                 marketData[pair].currentCandle = null; // IMPORTANT: Set to null if no data
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
            // Initialize currentCandle based on the last historical close
            marketData[pair].currentCandle = {
                asset: pair,
                timestamp: new Date(lastCandle.timestamp.getTime() + 60000), // Start of next minute
                open: lastCandle.close,
                high: lastCandle.close,
                low: lastCandle.close,
                close: lastCandle.close
            };
            console.log(`✅ Loaded ${marketData[pair].candles.length} historical candles for ${pair}.`);
        } catch (err) {
            console.error(`❌ Failed to load initial candles for ${pair}:`, (err && err.message) || (err && err.body) || err);
            marketData[pair].currentCandle = null;
        }
    }
}

// ⭐ FIX: Updated stream function to be more resilient and candle-aware
function startMarketDataStream() {
    console.log("⚡ Starting unauthenticated Binance WebSocket stream...");
    
    // Use a try-catch block around the subscription to ensure errors don't stop the whole server
    try {
        const streams = TRADE_PAIRS.map(pair => `${pair.toLowerCase()}@trade`);
        
        // Subscribe to the unauthenticated public trade stream
        binance.futuresSubscribe(streams, (trade) => {
            try {
                const pair = trade.s;
                const price = parseFloat(trade.p);

                // Update current price
                marketData[pair].currentPrice = price;

                const md = marketData[pair];
                if (!md) return; 

                const now = new Date();
                const currentMinuteStart = new Date(now);
                currentMinuteStart.setSeconds(0, 0);
                currentMinuteStart.setMilliseconds(0);

                // Initialize currentCandle if it's null (e.g., if historical load failed)
                if (!md.currentCandle) {
                    md.currentCandle = { 
                        asset: pair, 
                        timestamp: currentMinuteStart, 
                        open: price, 
                        high: price, 
                        low: price, 
                        close: price 
                    };
                    // Emit initial data
                    const allCandles = [...md.candles, md.currentCandle];
                    io.emit("market_data", { asset: pair, candles: allCandles, currentPrice: price });
                    return; // Wait for the next tick
                }
                
                const isNewMinute = md.currentCandle.timestamp.getTime() !== currentMinuteStart.getTime();

                if (isNewMinute) {
                    // Finalize the last candle
                    const completed = { ...md.currentCandle, close: price };
                    
                    // --- APPLY OVERRIDE LOGIC HERE ---
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
                    
                    md.candles.push(completed);
                    if (md.candles.length > 200) md.candles.shift();
                    
                    Candle.updateOne({ asset: pair, timestamp: completed.timestamp }, { $set: completed }, { upsert: true }).catch(err => {
                        console.error(`DB Error saving completed candle for ${pair}:`, err.message);
                    });
                    
                    // Start new candle for the current minute
                    md.currentCandle = { 
                        asset: pair, 
                        timestamp: currentMinuteStart, 
                        open: price, 
                        high: price, 
                        low: price, 
                        close: price 
                    };
                } else {
                    // Update the current candle with the latest price
                    md.currentCandle.high = Math.max(md.currentCandle.high, price);
                    md.currentCandle.low = Math.min(md.currentCandle.low, price);
                    md.currentCandle.close = price;
                }

                // Emit the real-time data to connected clients
                const allCandles = [...md.candles, md.currentCandle];
                io.emit("market_data", { asset: pair, candles: allCandles, currentPrice: price });
            } catch (streamErr) {
                console.error(`❌ CRITICAL STREAM PROCESSING ERROR for ${pair}:`, streamErr);
                // This error will only stop the processing for this specific trade event, not the entire stream
            }
        });
    } catch (subErr) {
        console.error("❌ BINANCE SUBSCRIPTION FAILED:", subErr);
        // This is a major failure. You might want to retry subscription here.
    }
}


// ------------------ DASHBOARD PRICE EMITTER ------------------
// This function remains to format and emit the data for your dashboard components.
setInterval(() => {
    const now = new Date();
    const secondsUntilNextMinute = 60 - now.getSeconds();
    const payloadDashboard = {};
    const payloadTrading = {};

    for (const pair of TRADE_PAIRS) {
        const md = marketData[pair];
        // Ensure md is initialized before attempting to access
        if (!md || md.currentPrice === 0) continue; 
        
        const lastCandle = (md.candles && md.candles.length > 0) ? md.candles[md.candles.length - 1] : md.currentCandle;
        let change = 0;
        if (lastCandle && lastCandle.open !== 0) {
            change = ((md.currentPrice - lastCandle.open) / lastCandle.open) * 100;
        }

        // Dashboard format
        const tickerForClient = `${pair.replace('USDT', '')}/USD`;
        payloadDashboard[tickerForClient] = {
            price: md.currentPrice,
            change: parseFloat(change.toFixed(2)),
            countdown: secondsUntilNextMinute
        };

        // Trading format (old)
        payloadTrading[pair] = {
            price: md.currentPrice,
            countdown: secondsUntilNextMinute,
            timestamp: now.getTime()
        };
    }

    io.emit("price_update", payloadTrading);           
    io.emit("dashboard_price_update", payloadDashboard);
}, 1000);

// ------------------ DB + STARTUP ------------------
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));

db.once("open", async () => {
  console.log("✅ Connected to MongoDB");

  // >>> START CRASH PREVENTION/CLEANUP <<<
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
    console.error("Warning: Pre-boot database cleanup failed. Proceeding with trade initialization.", error.message);
  }
  // >>> END CRASH PREVENTION/CLEANUP <<<


  await initializeMarketData();
  startMarketDataStream(); // Start the stable stream

  const tradeModule = require("./trade");
  if (typeof tradeModule.initialize === "function") {
    tradeModule.initialize(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
  } else if (typeof tradeModule === "function") {
    tradeModule(io, User, Trade, marketData, TRADE_PAIRS, candleOverride);
  } else {
    console.error("Trade module export not recognized. Expected function or object with initialize()");
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
