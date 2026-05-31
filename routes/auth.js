// routes/auth.js - CORRECTED VERSION
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// --- REGISTER A NEW USER ---
router.post('/register', async (req, res) => {
    try {
        const { username, email, password, confirmPassword, region, refCode } = req.body;

        if (!username || !email || !password || !confirmPassword || !region) {
            return res.status(400).json({ message: "All fields are required." });
        }
        if (password !== confirmPassword) {
            return res.status(400).json({ message: "Passwords do not match." });
        }

        let referredBy = null;
        if (refCode) {
            const referrer = await User.findOne({ referralCode: refCode });
            if (referrer) {
                referredBy = referrer._id;
            }
        }

        const user = new User({ username, email, password, region, referredBy });

        // FIX 1: Removed infinite while loop.
        // Generate a unique referral code in one shot.
        // If by rare chance it collides, append timestamp to guarantee uniqueness.
        let referralCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const existingCode = await User.findOne({ referralCode });
        if (existingCode) {
            // Collision happened — append timestamp to make it unique
            referralCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${Date.now()}`;
        }
        user.referralCode = referralCode;

        await user.save();

        res.status(201).json({ message: "User registered successfully. Please log in." });

    } catch (error) {
        if (error.code === 11000) {
            if (error.keyPattern.username) {
                return res.status(409).json({ message: "Username already exists." });
            }
            if (error.keyPattern.email) {
                return res.status(409).json({ message: "Email is already registered." });
            }
        }
        console.error("Registration Error:", error);
        res.status(500).json({ message: "Server error during registration." });
    }
});

// --- LOGIN A USER ---
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ message: "Username and password are required." });
        }

        const user = await User.findOne({
            $or: [
                { username: username },
                { email: username }
            ]
        });

        if (!user || !(await user.comparePassword(password))) {
            return res.status(401).json({ message: "Invalid credentials." });
        }

        const payload = {
            id: user._id,
            username: user.username
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({
            message: "Logged in successfully.",
            token,
            user: {
                id: user._id,
                username: user.username,
                balance: user.balance
            }
        });

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ message: "Server error during login." });
    }
});

// ----------------------------------------------------------------------
// PASSWORD RESET ROUTES
// ----------------------------------------------------------------------

// [POST] /api/auth/reset-password/verify-identity (Step 1)
router.post('/reset-password/verify-identity', async (req, res) => {
    const { username, fullName, identityNumber } = req.body;

    if (!username || !fullName || !identityNumber) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    try {
        // FIX 2: Find user by username OR email
        const user = await User.findOne({
            $or: [
                { username: username },
                { email: username }
            ]
        });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Verification failed. Please check your credentials.' });
        }

        if (!user.fullName || !user.identityNumber) {
            return res.status(400).json({ success: false, message: 'KYC identity data is missing for this account.' });
        }

        const nameMatches = user.fullName.trim().toLowerCase() === fullName.trim().toLowerCase();
        const idMatches = user.identityNumber.trim().toLowerCase() === identityNumber.trim().toLowerCase();

        if (nameMatches && idMatches) {
            const resetToken = crypto.randomBytes(32).toString('hex');

            user.resetToken = resetToken;
            user.resetTokenExpires = Date.now() + 600000; // 10 minutes

            await user.save();

            return res.json({
                success: true,
                message: 'Identity verified. You can now set a new password.',
                resetToken: resetToken
            });

        } else {
            return res.status(400).json({ success: false, message: 'Verification failed. Please check your credentials.' });
        }

    } catch (error) {
        console.error('Password Reset Identity Verification Error:', error);
        res.status(500).json({ success: false, message: 'A server error occurred during verification.' });
    }
});

// [POST] /api/auth/reset-password/update-password (Step 2)
router.post('/reset-password/update-password', async (req, res) => {
    const { username, newPassword, resetToken } = req.body;

    if (!username || !newPassword || !resetToken) {
        return res.status(400).json({ success: false, message: 'Username, new password, and reset token are required.' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    try {
        // FIX 2: Find user by username OR email + token validation
        const user = await User.findOne({
            $or: [
                { username: username },
                { email: username }
            ],
            resetToken: resetToken,
            resetTokenExpires: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ success: false, message: 'Token is invalid or has expired. Please restart the verification process.' });
        }

        user.password = newPassword;

        // Invalidate token after use
        user.resetToken = undefined;
        user.resetTokenExpires = undefined;

        await user.save();

        res.json({ success: true, message: 'Password updated successfully. You can now log in.' });

    } catch (error) {
        console.error('Password Update Error:', error);
        res.status(500).json({ success: false, message: 'A server error occurred while updating the password.' });
    }
});

module.exports = router;
