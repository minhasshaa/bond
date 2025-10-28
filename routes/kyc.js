const express = require('express');
const multer = require('multer');
const User = require('../models/User');
const jwt = require('jsonwebtoken');

// Set up Multer for handling file uploads in memory
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // Max 5MB per file
});

// User authentication middleware
const userAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Authentication required: Missing token.' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.id;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Authentication failed: Invalid token.' });
    }
};


// The entire module is a function that accepts Azure dependencies
module.exports = function({ blobServiceClient, KYC_CONTAINER_NAME, azureEnabled = false }) {
    const router = express.Router();

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/status - Fetch current KYC status (used on Profile load)
    // ----------------------------------------------------------------------
    router.get('/status', userAuth, async (req, res) => {
        try {
            // Include identity information in the status response
            const user = await User.findById(req.userId).select('kycStatus kycRejectionReason fullName identityNumber');
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }

            res.json({
                success: true,
                kycStatus: user.kycStatus || 'pending',
                rejectionReason: user.kycRejectionReason,
                // New fields to tell the frontend if identity step is complete
                identitySubmitted: !!(user.fullName && user.identityNumber)
            });

        } catch (error) {
            console.error('KYC Status Fetch Error:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch KYC status.' });
        }
    });

    // ----------------------------------------------------------------------
    // [POST] /api/kyc/verify-identity - Verify if ID is already registered
    // ----------------------------------------------------------------------
    router.post('/verify-identity', userAuth, async (req, res) => {
        const { fullName, identityNumber } = req.body;

        if (!fullName || !identityNumber) {
            return res.status(400).json({ success: false, message: 'Full Name and Identity Number are required.' });
        }

        try {
            // 1. Check for existing user with the same Identity Number or Full Name
            const existingUser = await User.findOne({ 
                $or: [
                    { identityNumber: identityNumber.trim() },
                    { fullName: fullName.trim() }
                ],
                _id: { $ne: req.userId } // Exclude the current user's document
            });

            if (existingUser) {
                // Identity already exists in the system
                return res.status(409).json({
                    success: false,
                    message: 'This identity (name or ID number) is already associated with another account.',
                    reason: 'already_exists'
                });
            }

            // 2. Identity is new, save it to the current user's profile
            const user = await User.findById(req.userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'User record not found.' });
            }

            user.fullName = fullName.trim();
            user.identityNumber = identityNumber.trim();
            
            // Set status to pending if it's the first step and not already reviewed/verified/rejected
            if (user.kycStatus === 'pending') {
                // Identity submitted, user can proceed to upload
            }

            await user.save();

            res.json({
                success: true,
                message: 'Identity confirmed. Proceed to document upload.',
                reason: 'new_identity'
            });

        } catch (error) {
            console.error('KYC Identity Verification Error:', error);
            // Handle unique index errors specifically (though Mongoose unique validation should catch this)
            if (error.code === 11000) { 
                 return res.status(409).json({ 
                    success: false, 
                    message: 'This name or ID number is already registered in the system.',
                    reason: 'already_exists_db'
                });
            }
            res.status(500).json({ success: false, message: 'Failed to complete identity verification due to a server error.' });
        }
    });


    // ----------------------------------------------------------------------
    // [POST] /api/kyc/upload - Handle file upload and status update (now includes selfie)
    // ----------------------------------------------------------------------
    router.post('/upload', userAuth, upload.fields([
        { name: 'front', maxCount: 1 },
        { name: 'back', maxCount: 1 },
        { name: 'selfie', maxCount: 1 } // Added selfie
    ]), async (req, res) => {
        // 1. Validation Checks
        if (!req.files || !req.files.front || !req.files.back || !req.files.selfie) {
            console.error("KYC Upload Error: Missing files (front, back, or selfie).");
            return res.status(400).json({ success: false, message: 'Please select ID front, ID back, and a selfie file.' });
        }

        // CRITICAL FIX: Check if Azure connection succeeded during app startup
        if (!blobServiceClient || !KYC_CONTAINER_NAME || !azureEnabled) {
            console.error("KYC Upload Error: Azure Storage service is unavailable.");
            return res.status(503).json({
                success: false,
                message: 'KYC upload service is temporarily disabled. Storage connection failed.'
            });
        }

        const userId = req.userId;
        const frontFile = req.files.front[0];
        const backFile = req.files.back[0];
        const selfieFile = req.files.selfie[0]; // New file
        
        // Define secure blob paths
        const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
        const frontBlobPath = `${userId}/front_${Date.now()}_${frontFile.originalname}`;
        const backBlobPath = `${userId}/back_${Date.now()}_${backFile.originalname}`;
        const selfieBlobPath = `${userId}/selfie_${Date.now()}_${selfieFile.originalname}`; // New path

        try {
            // 2. Upload Files to Azure Blob Storage

            const frontBlobClient = containerClient.getBlockBlobClient(frontBlobPath);
            await frontBlobClient.uploadData(frontFile.buffer, {
                blobHTTPHeaders: { blobContentType: frontFile.mimetype }
            });

            const backBlobClient = containerClient.getBlockBlobClient(backBlobPath);
            await backBlobClient.uploadData(backFile.buffer, {
                blobHTTPHeaders: { blobContentType: backFile.mimetype }
            });
            
            const selfieBlobClient = containerClient.getBlockBlobClient(selfieBlobPath); // New upload
            await selfieBlobClient.uploadData(selfieFile.buffer, {
                blobHTTPHeaders: { blobContentType: selfieFile.mimetype }
            });


            // 3. Update User KYC Status in Database
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'User record not found.' });
            }

            // Ensure name and ID were submitted via /verify-identity first
            if (!user.fullName || !user.identityNumber) {
                 return res.status(400).json({ success: false, message: 'Please complete the Name and ID verification step first.' });
            }

            user.kycStatus = 'review';
            user.kycDocuments = {
                front: frontBlobPath,
                back: backBlobPath,
                selfie: selfieBlobPath, // Save selfie path
                uploadDate: new Date()
            };
            user.kycRejectionReason = undefined;

            await user.save();

            // 4. Send successful response
            res.json({
                success: true,
                message: 'Documents and Selfie uploaded successfully. Your KYC status is now under review.',
                kycStatus: 'review'
            });

        } catch (error) {
            console.error('KYC Upload/Save Error:', error);
            res.status(500).json({ success: false, message: 'Failed to complete KYC submission due to a server error.' });
        }
    });

    return router;
};
