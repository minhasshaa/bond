// routes/withdraw.js - CORRECTED VERSION
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

router.post('/request', async (req, res) => {
    const { amount, address } = req.body;

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'Please enter a valid amount.' });
    }
    if (!address || typeof address !== 'string' || address.length < 26) {
        return res.status(400).json({ success: false, message: 'Please enter a valid withdrawal address.' });
    }

    // FIX: Wrap everything in a MongoDB session to prevent balance deduction
    // without withdrawal record being saved
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const user = await User.findById(req.user.id).session(session);
        if (!user) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        const withdrawalAmount = parseFloat(amount);
        if (user.balance < withdrawalAmount) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: 'Insufficient balance.' });
        }

        // --- TRADING VOLUME REQUIREMENT LOGIC ---
        const volumeRequirement = user.totalDeposits * 1.10;
        let taxAmount = 0;
        let finalAmount = withdrawalAmount;
        let responseMessage = 'Withdrawal request submitted successfully. It will be processed shortly.';

        if (user.totalTradeVolume < volumeRequirement) {
            taxAmount = withdrawalAmount * 0.50;
            finalAmount = withdrawalAmount - taxAmount;
            responseMessage = `A 50% tax of $${taxAmount.toFixed(2)} was applied for not meeting the trading volume requirement. Your request has been submitted.`;
        }
        // --- END OF LOGIC ---

        user.balance -= withdrawalAmount;

        user.transactions.push({
            txid: `WITHDRAW-${Date.now()}`,
            type: 'withdrawal',
            amount: withdrawalAmount,
            address: address,
            status: 'pending_processing',
            date: new Date(),
            tax: taxAmount,
            finalAmount: finalAmount
        });

        await user.save({ session });

        await session.commitTransaction();
        session.endSession();

        res.json({
            success: true,
            message: responseMessage,
            newBalance: user.balance
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Withdrawal request error:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

router.get('/history', async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('transactions');
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        const withdrawalHistory = user.transactions
            .filter(tx => tx.type === 'withdrawal')
            .sort((a, b) => b.date - a.date);

        res.json({ success: true, history: withdrawalHistory });
    } catch (error) {
        console.error('Error fetching withdrawal history:', error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

module.exports = router;
