const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { ethers } = require("ethers");
const User = require('../models/User');

// Auth middleware (Your original, working version)
const auth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ message: 'Authentication required' });
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).json({ message: 'Invalid or expired token' });
    }
};

// Get next available deposit index
async function getNextDepositIndex() {
    try {
        const lastUser = await User.findOne({ depositAddressIndex: { $exists: true } }).sort({ depositAddressIndex: -1 });
        return lastUser ? lastUser.depositAddressIndex + 1 : 0;
    } catch (error) {
        console.error('Error getting deposit index:', error);
        return 0;
    }
}

// Get or generate deposit address
router.get("/address", auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        if (user.depositAddress) {
            return res.json({ success: true, address: user.depositAddress });
        }

        if (!process.env.SEED_PHRASE) {
            return res.status(500).json({ success: false, message: "Server configuration error." });
        }

        const userIndex = await getNextDepositIndex();
        let address;
        try {
            const masterNode = ethers.HDNodeWallet.fromPhrase(process.env.SEED_PHRASE);
            const childNode = masterNode.derivePath(`44'/60'/0'/0/${userIndex}`);
            address = childNode.address;
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to generate address." });
        }

        user.depositAddress = address;
        user.depositAddressIndex = userIndex;
        await user.save();
        res.json({ success: true, address: address });
    } catch (error) {
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

// MODIFIED: Handle TXID and Amount Submission for Verification
router.post("/verify", auth, async (req, res) => {
    // MODIFIED: Get both txid and amount from the request body
    const { txid, amount } = req.body;

    if (!txid || typeof txid !== 'string' || txid.length < 10) {
        return res.status(400).json({ success: false, message: "Invalid TXID provided." });
    }
    // MODIFIED: Added validation for amount
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: "Invalid amount provided." });
    }

    try {
        const existingTx = await User.findOne({ 'transactions.txid': txid });
        if (existingTx) {
            return res.status(400).json({ success: false, message: "This transaction has already been submitted." });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        // MODIFIED: Push the amount along with the txid
        user.transactions.push({ txid: txid, amount: parseFloat(amount) });
        await user.save();

        console.log(`SAVED TXID "${txid}" for user ${user.username} with amount ${amount}.`);
        res.json({ success: true, message: "Deposit details submitted successfully." });
    } catch (error) {
        res.status(500).json({ success: false, message: "An internal server error occurred." });
    }
});

// Get Deposit History
router.get("/history", auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('transactions');
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        const sortedTransactions = user.transactions.sort((a, b) => b.date - a.date);
        res.json({ success: true, history: sortedTransactions });
    } catch (error) {
        console.error('Error fetching deposit history:', error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

module.exports = router;
