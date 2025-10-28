const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto'); // Needed to generate random codes
const bcrypt = require('bcryptjs'); // Needed for password hashing

// --- REGISTER A NEW USER ---
router.post('/register', async (req, res) => {
    try {
        // ✅ CHANGED: Added 'refCode' to the request body
        const { username, email, password, confirmPassword, region, refCode } = req.body;

        if (!username || !email || !password || !confirmPassword || !region) {  
            return res.status(400).json({ message: "All fields are required." });  
        }  
        if (password !== confirmPassword) {  
            return res.status(400).json({ message: "Passwords do not match." });
        }  

        let referredBy = null;
        // This logic is now correctly receiving the refCode from the frontend
        if (refCode) {
            const referrer = await User.findOne({ referralCode: refCode });
            if (referrer) {
                referredBy = referrer._id;
            }
        }

        // Create a new user, including the referrer's ID if found
        const user = new User({ username, email, password, region, referredBy });  

        // ✅ NEW: Generate a unique referral code for the new user
        let isUnique = false;
        let referralCode = '';
        while (!isUnique) {
            referralCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            const existingUser = await User.findOne({ referralCode: referralCode });
            if (!existingUser) {
                isUnique = true;
            }
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

        const user = await User.findOne({ username });  
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
// NEW: PASSWORD RESET ROUTES (KYC Verification)
// ----------------------------------------------------------------------

// [POST] /api/auth/reset-password/verify-identity
// Verifies user's identity against KYC data (Full Name and ID Number)
router.post('/reset-password/verify-identity', async (req, res) => {
    const { username, fullName, identityNumber } = req.body;

    if (!username || !fullName || !identityNumber) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    try {
        const user = await User.findOne({ username });

        if (!user) {
            // Return a generic error to prevent user enumeration
            return res.status(400).json({ success: false, message: 'Verification failed. Please check your credentials.' });
        }
        
        // Ensure KYC data is present on the user's profile
        if (!user.fullName || !user.identityNumber) {
             return res.status(400).json({ success: false, message: 'KYC identity data is missing for this account. Please contact support.' });
        }

        // Perform strict case-insensitive comparison for name and ID number
        const nameMatches = user.fullName.trim().toLowerCase() === fullName.trim().toLowerCase();
        const idMatches = user.identityNumber.trim().toLowerCase() === identityNumber.trim().toLowerCase();

        if (nameMatches && idMatches) {
            // Identity verified successfully
            return res.json({ success: true, message: 'Identity verified. You can now set a new password.' });
        } else {
            return res.status(400).json({ success: false, message: 'Verification failed. Full Name or Identity Number do not match our records.' });
        }

    } catch (error) {
        console.error('Password Reset Identity Verification Error:', error);
        res.status(500).json({ success: false, message: 'A server error occurred during verification.' });
    }
});


// [POST] /api/auth/reset-password/update-password
// Sets the new password after identity verification
router.post('/reset-password/update-password', async (req, res) => {
    const { username, newPassword } = req.body;

    if (!username || !newPassword) {
        return res.status(400).json({ success: false, message: 'Username and new password are required.' });
    }
    
    // Simple password complexity check
    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    try {
        const user = await User.findOne({ username });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        
        // The user model's pre('save') hook will automatically hash the new password when saving
        user.password = newPassword; 

        await user.save();

        res.json({ success: true, message: 'Password updated successfully.' });

    } catch (error) {
        console.error('Password Update Error:', error);
        res.status(500).json({ success: false, message: 'A server error occurred while updating the password.' });
    }
});

module.exports = router;
