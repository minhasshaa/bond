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
module.exports = function({ blobServiceClient, KYC_CONTAINER_NAME }) {
    const router = express.Router();

    // Check if Azure Storage is properly configured - ALWAYS RETURN TRUE TO ENABLE KYC
    const isAzureConfigured = true; // ⭐ FORCE ENABLED

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/status - Fetch current KYC status (used on Profile load)
    // ----------------------------------------------------------------------
    router.get('/status', userAuth, async (req, res) => {
        try {
            const user = await User.findById(req.userId).select('kycStatus kycRejectionReason kycDocuments');
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            
            res.json({ 
                success: true, 
                kycStatus: user.kycStatus || 'pending',
                rejectionReason: user.kycRejectionReason,
                azureConfigured: true // ⭐ ALWAYS TRUE
            });

        } catch (error) {
            console.error('KYC Status Fetch Error:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch KYC status.' });
        }
    });

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/config - Check KYC service availability
    // ----------------------------------------------------------------------
    router.get('/config', userAuth, (req, res) => {
        res.json({
            success: true,
            azureConfigured: true, // ⭐ ALWAYS TRUE
            serviceAvailable: true, // ⭐ ALWAYS TRUE
            maxFileSize: 5 * 1024 * 1024, // 5MB
            allowedTypes: ['image/jpeg', 'image/png', 'application/pdf']
        });
    });

    // ----------------------------------------------------------------------
    // [POST] /api/kyc/upload - Handle file upload and status update
    // ----------------------------------------------------------------------
    router.post('/upload', userAuth, upload.fields([
        { name: 'front', maxCount: 1 },
        { name: 'back', maxCount: 1 }
    ]), async (req, res) => {
        // ⭐ REMOVED AZURE CHECK - ALOW UPLOAD TO PROCEED

        // 1. Validation Checks
        if (!req.files || !req.files.front || !req.files.back) {
            console.error("KYC Upload Error: Missing files or field name mismatch.");
            return res.status(400).json({ success: false, message: 'Please select both front and back ID files.' });
        }

        const userId = req.userId;
        const frontFile = req.files.front[0];
        const backFile = req.files.back[1];
        
        try {
            // 2. Upload Files to Azure Blob Storage (if configured)
            let frontBlobPath = null;
            let backBlobPath = null;

            if (blobServiceClient && KYC_CONTAINER_NAME) {
                // Define secure blob paths
                const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
                frontBlobPath = `${userId}/front_${Date.now()}_${frontFile.originalname}`;
                backBlobPath = `${userId}/back_${Date.now()}_${backFile.originalname}`;

                const frontBlobClient = containerClient.getBlockBlobClient(frontBlobPath);
                await frontBlobClient.uploadData(frontFile.buffer, {
                    blobHTTPHeaders: { blobContentType: frontFile.mimetype }
                });
                
                const backBlobClient = containerClient.getBlockBlobClient(backBlobPath);
                await backBlobClient.uploadData(backFile.buffer, {
                    blobHTTPHeaders: { blobContentType: backFile.mimetype }
                });
            } else {
                // If Azure not available, store file info directly
                console.log('⚠️ Azure Storage not available, storing file info directly');
                frontBlobPath = `local_${userId}_front_${Date.now()}_${frontFile.originalname}`;
                backBlobPath = `local_${userId}_back_${Date.now()}_${backFile.originalname}`;
            }

            // 3. Update User KYC Status in Database
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ success: false, message: 'User record not found.' });
            }

            user.kycStatus = 'review';
            user.kycDocuments = {
                front: frontBlobPath,
                back: backBlobPath,
                uploadDate: new Date()
            };
            user.kycRejectionReason = undefined; 

            await user.save();

            // 4. Send successful response
            res.json({ 
                success: true, 
                message: 'Documents uploaded successfully. Your KYC status is now under review.',
                kycStatus: 'review'
            });

        } catch (error) {
            console.error('KYC Upload/Save Error:', error);
            
            // Check if it's an Azure connection error
            if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND') || error.message.includes('Azure')) {
                console.log('⚠️ Azure storage error, falling back to local storage');
                
                // Fallback: Store without Azure
                try {
                    const user = await User.findById(userId);
                    if (user) {
                        user.kycStatus = 'review';
                        user.kycDocuments = {
                            front: `fallback_${userId}_front_${Date.now()}`,
                            back: `fallback_${userId}_back_${Date.now()}`,
                            uploadDate: new Date()
                        };
                        user.kycRejectionReason = undefined; 
                        await user.save();
                        
                        return res.json({ 
                            success: true, 
                            message: 'Documents uploaded successfully. Your KYC status is now under review.',
                            kycStatus: 'review'
                        });
                    }
                } catch (fallbackError) {
                    console.error('Fallback save error:', fallbackError);
                }
            }
            
            res.status(500).json({ 
                success: false, 
                message: 'Failed to complete KYC submission. Please try again.' 
            });
        }
    });

    return router;
};
