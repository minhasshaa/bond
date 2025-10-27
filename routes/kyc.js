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

    // Helper function to check Azure connection
    const checkAzureConnection = () => {
        if (!azureEnabled || !blobServiceClient || !KYC_CONTAINER_NAME) {
            throw new Error('KYC service connection failed. Azure Storage not configured.');
        }
    };

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/status - Fetch current KYC status (used on Profile load)
    // ----------------------------------------------------------------------
    router.get('/status', userAuth, async (req, res) => {
        try {
            const user = await User.findById(req.userId).select('kycStatus kycRejectionReason kycDocuments');
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            
            // Check if Azure is properly configured for KYC functionality
            if (!azureEnabled) {
                return res.json({ 
                    success: true, 
                    kycStatus: user.kycStatus || 'pending',
                    rejectionReason: user.kycRejectionReason,
                    serviceStatus: 'disabled',
                    message: 'KYC service is currently unavailable'
                });
            }
            
            res.json({ 
                success: true, 
                kycStatus: user.kycStatus || 'pending',
                rejectionReason: user.kycRejectionReason,
                serviceStatus: 'active'
            });

        } catch (error) {
            console.error('KYC Status Fetch Error:', error);
            res.status(500).json({ 
                success: false, 
                message: 'Failed to fetch KYC status.',
                serviceStatus: 'error'
            });
        }
    });

    // ----------------------------------------------------------------------
    // [POST] /api/kyc/upload - Handle file upload and status update
    // ----------------------------------------------------------------------
    router.post('/upload', userAuth, upload.fields([
        { name: 'front', maxCount: 1 },
        { name: 'back', maxCount: 1 }
    ]), async (req, res) => {
        try {
            // 1. Validation Checks
            if (!req.files || !req.files.front || !req.files.back) {
                console.error("KYC Upload Error: Missing files or field name mismatch.");
                console.log("Files received:", req.files);
                return res.status(400).json({ 
                    success: false, 
                    message: 'Please select both front and back ID files.' 
                });
            }

            // 2. Check Azure Connection
            checkAzureConnection();

            const userId = req.userId;
            const frontFile = req.files.front[0];
            const backFile = req.files.back[0]; // ✅ FIXED: Changed from [1] to [0]
            
            // Debug logging
            console.log("Processing KYC upload for user:", userId);
            console.log("Front file:", frontFile.originalname, frontFile.size, "bytes");
            console.log("Back file:", backFile.originalname, backFile.size, "bytes");

            // 3. Create container if it doesn't exist
            const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
            await containerClient.createIfNotExists({ access: 'blob' });

            // 4. Define secure blob paths
            const frontBlobPath = `kyc-${userId}/front_${Date.now()}_${frontFile.originalname}`;
            const backBlobPath = `kyc-${userId}/back_${Date.now()}_${backFile.originalname}`;

            // 5. Upload Files to Azure Blob Storage
            console.log("Uploading front file to Azure...");
            const frontBlobClient = containerClient.getBlockBlobClient(frontBlobPath);
            await frontBlobClient.uploadData(frontFile.buffer, {
                blobHTTPHeaders: { blobContentType: frontFile.mimetype }
            });
            
            console.log("Uploading back file to Azure...");
            const backBlobClient = containerClient.getBlockBlobClient(backBlobPath);
            await backBlobClient.uploadData(backFile.buffer, {
                blobHTTPHeaders: { blobContentType: backFile.mimetype }
            });

            console.log("Files uploaded successfully, updating user record...");

            // 6. Update User KYC Status in Database
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ 
                    success: false, 
                    message: 'User record not found.' 
                });
            }

            user.kycStatus = 'under_review';
            user.kycDocuments = {
                front: frontBlobPath,
                back: backBlobPath,
                uploadDate: new Date()
            };
            user.kycRejectionReason = undefined; 

            await user.save();

            console.log("KYC upload completed successfully for user:", userId);

            // 7. Send successful response
            res.json({ 
                success: true, 
                message: 'Documents uploaded successfully. Your KYC status is now under review.',
                kycStatus: 'under_review',
                serviceStatus: 'active'
            });

        } catch (error) {
            console.error('KYC Upload/Save Error:', error);
            
            if (error.message.includes('Azure Storage not configured')) {
                return res.status(503).json({ 
                    success: false, 
                    message: 'KYC service is currently unavailable. Please try again later.',
                    serviceStatus: 'disabled',
                    currentStatus: 'Service connection failed'
                });
            }
            
            res.status(500).json({ 
                success: false, 
                message: 'Failed to complete KYC submission due to a server error.',
                serviceStatus: 'error'
            });
        }
    });

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/service-status - Check if KYC service is available
    // ----------------------------------------------------------------------
    router.get('/service-status', userAuth, async (req, res) => {
        try {
            if (!azureEnabled) {
                return res.json({
                    success: true,
                    serviceAvailable: false,
                    status: 'KYC service connection failed - Azure not configured',
                    currentStatus: 'Service connection failed'
                });
            }

            // Test Azure connection
            const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
            await containerClient.getProperties();
            
            res.json({
                success: true,
                serviceAvailable: true,
                status: 'KYC service is active and connected',
                currentStatus: 'Service connected'
            });

        } catch (error) {
            console.error('KYC Service Status Check Error:', error);
            res.json({
                success: true,
                serviceAvailable: false,
                status: 'KYC service connection failed - ' + error.message,
                currentStatus: 'Service connection failed'
            });
        }
    });

    return router;
};
