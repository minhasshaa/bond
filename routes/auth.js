const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { Types } = require('mongoose');

// --- Nodemailer Setup ---
const transporter = nodemailer.createTransport({
    // FIX: Using Port 465 and secure: true to bypass ETIMEDOUT error
    host: process.env.EMAIL_SMTP_HOST || 'smtp.gmail.com', 
    port: 465, 
    secure: true, 
    auth: {
        user: process.env.EMAIL_SERVICE_USER, 
        pass: process.env.EMAIL_SERVICE_PASS
    }
});

// Helper to generate a 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// Helper function to find referrer ID
async function getReferrerId(code) {
    const referrer = await User.findOne({ referralCode: code }).select('_id');
    return referrer ? referrer._id : null;
}

// [POST] /api/auth/signup (formerly /register) - MODIFIED TO SEND VERIFICATION CODE
router.post('/signup', async (req, res) => {
    const { username, password, email, refCode } = req.body; 

    if (!username || !password || !email) {
         return res.status(400).json({ success: false, message: 'Username, password, and email are required.' });
    }

    try {
        const existingUser = await User.findOne({ $or: [{ username }, { email }] });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Username or email is already in use.' });
        }

        const verificationCode = generateOTP();
        const codeExpires = new Date(Date.now() + 10 * 60 * 1000); 
        
        let referredBy = null;
        if (refCode) {
            referredBy = await getReferrerId(refCode);
        }

        // --- 1. CREATE USER WITH VERIFICATION DATA ---
        const newUser = new User({
            username,
            password,
            email,
            isVerified: false,
            verificationCode,
            verificationCodeExpires: codeExpires,
            referredBy: referredBy,
            totalDeposits: 0,
            totalTradeVolume: 0,
        });

        // Generate a unique referral code
        let isUnique = false;
        let referralCode = '';
        while (!isUnique) {
            referralCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            const existingCode = await User.findOne({ referralCode: referralCode });
            if (!existingCode) {
                isUnique = true;
            }
        }
        newUser.referralCode = referralCode;

        await newUser.save();

        // --- 2. SEND EMAIL ---
        const mailOptions = {
            from: process.env.EMAIL_SERVICE_USER || 'noreply@app.com',
            to: email,
            subject: 'Your Trading App Verification Code',
            html: `
                <p>Welcome to the Trading Platform!</p>
                <p>Your verification code is: <strong>${verificationCode}</strong></p>
                <p>This code is valid for 10 minutes. Do not share it with anyone.</p>
            `,
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error('Email send error:', error);
            }
        });

        // --- 3. RESPOND ---
        res.json({ 
            success: true, 
            message: 'User created. Verification code sent to your email.', 
            userId: newUser._id
        });

    } catch (error) {
        if (error.code === 11000) {
            if (error.keyPattern.username) {
                return res.status(409).json({ success: false, message: "Username already exists." });
            }
            if (error.keyPattern.email) {
                return res.status(409).json({ success: false, message: "Email is already registered." });
            }
        }
        console.error('Signup error:', error);
        res.status(500).json({ success: false, message: 'Server error during signup.' });
    }
});

// [POST] /api/auth/verify - NEW ENDPOINT TO VERIFY CODE
router.post('/verify', async (req, res) => {
    const { userId, code } = req.body;

    try {
        if (!Types.ObjectId.isValid(userId)) {
             return res.status(400).json({ success: false, message: 'Invalid user ID.' });
        }
        
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        
        if (user.isVerified) {
            const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
            return res.json({ success: true, message: 'Account already verified. Logging in.', token });
        }

        // Check code and expiry
        if (user.verificationCode !== code || user.verificationCodeExpires < new Date()) {
            return res.status(400).json({ success: false, message: 'Invalid or expired verification code.' });
        }

        // Verification successful
        user.isVerified = true;
        user.verificationCode = undefined;
        user.verificationCodeExpires = undefined;
        await user.save();

        const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });

        res.json({ success: true, message: 'Account successfully verified and logged in.', token });

    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ success: false, message: 'Server error during verification.' });
    }
});

// [POST] /api/auth/login - MODIFIED TO CHECK VERIFICATION STATUS
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await User.findOne({ username });
        if (!user || !(await user.comparePassword(password))) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        // --- CRITICAL VERIFICATION CHECK ---
        if (!user.isVerified) {
            return res.status(403).json({ 
                success: false, 
                message: 'Account not verified. Please check your email for the verification code.', 
                requiresVerification: true,
                userId: user._id, 
                email: user.email // ADDED: Return email for frontend redirect
            });
        }
        // --- END CHECK ---

        const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ 
            success: true, 
            token,
            user: {
                id: user._id,
                username: user.username,
                balance: user.balance
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

module.exports = router;
