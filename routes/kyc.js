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
            console.log('🔧 KYC Upload Started - Azure Storage Only');
            
            // 1. Validation Checks
            if (!req.files || !req.files.front || !req.files.back) {
                console.error("KYC Upload Error: Missing files or field name mismatch.");
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
            
            console.log('🔧 Files received - Front:', frontFile.originalname, 'Back:', backFile.originalname);

            // 3. Validate file buffers
            if (!frontFile.buffer || !backFile.buffer) {
                console.error("KYC Upload Error: File buffers are empty");
                return res.status(400).json({ 
                    success: false, 
                    message: 'Invalid file data. Please try uploading again.' 
                });
            }

            // 4. Create container if it doesn't exist
            const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
            await containerClient.createIfNotExists({ access: 'blob' });

            // 5. Define secure blob paths
            const frontBlobPath = `kyc-${userId}/front_${Date.now()}_${frontFile.originalname}`;
            const backBlobPath = `kyc-${userId}/back_${Date.now()}_${backFile.originalname}`;

            console.log('🔧 Uploading to Azure Blob Storage...');

            // 6. Upload Files to Azure Blob Storage
            const frontBlobClient = containerClient.getBlockBlobClient(frontBlobPath);
            await frontBlobClient.uploadData(frontFile.buffer, {
                blobHTTPHeaders: { blobContentType: frontFile.mimetype }
            });
            
            const backBlobClient = containerClient.getBlockBlobClient(backBlobPath);
            await backBlobClient.uploadData(backFile.buffer, {
                blobHTTPHeaders: { blobContentType: backFile.mimetype }
            });

            console.log('✅ Azure upload successful');

            // 7. Update User KYC Status in Database
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
                uploadDate: new Date(),
                storageType: 'azure'
            };
            user.kycRejectionReason = undefined; 

            await user.save();

            console.log('✅ User KYC status updated to under_review');

            // 8. Send successful response
            res.json({ 
                success: true, 
                message: 'Documents uploaded successfully. Your KYC status is now under review.',
                kycStatus: 'under_review',
                serviceStatus: 'active',
                storage: 'azure'
            });

        } catch (error) {
            console.error('❌ KYC Upload/Save Error:', error);
            
            if (error.message.includes('Azure Storage not configured')) {
                return res.status(503).json({ 
                    success: false, 
                    message: 'KYC service is currently unavailable. Azure Storage not configured.',
                    serviceStatus: 'disabled',
                    currentStatus: 'Service connection failed'
                });
            }
            
            if (error.message.includes('Public access is not permitted')) {
                return res.status(503).json({ 
                    success: false, 
                    message: 'KYC service configuration error. Azure Storage public access is disabled.',
                    serviceStatus: 'disabled',
                    solution: 'Enable "Allow blob public access" in Azure Portal → Storage Account → Configuration'
                });
            }
            
            if (error.message.includes('File too large')) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'File size too large. Please upload files smaller than 5MB.',
                    serviceStatus: 'active'
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
                status: 'KYC service is active and connected to Azure Storage',
                currentStatus: 'Service connected'
            });

        } catch (error) {
            console.error('KYC Service Status Check Error:', error);
            
            if (error.statusCode === 403) {
                return res.json({
                    success: true,
                    serviceAvailable: false,
                    status: 'KYC service connection failed - Azure Storage public access disabled',
                    currentStatus: 'Service configuration error',
                    solution: 'Enable "Allow blob public access" in Azure Portal'
                });
            }
            
            res.json({
                success: true,
                serviceAvailable: false,
                status: 'KYC service connection failed - ' + error.message,
                currentStatus: 'Service connection failed'
            });
        }
    });

    // ----------------------------------------------------------------------
    // [GET] /api/kyc/debug - Debug endpoint to check current configuration
    // ----------------------------------------------------------------------
    router.get('/debug', userAuth, async (req, res) => {
        try {
            const user = await User.findById(req.userId).select('kycStatus kycDocuments');
            
            let azureStatus = 'unknown';
            try {
                const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
                await containerClient.getProperties();
                azureStatus = 'connected';
            } catch (error) {
                azureStatus = 'error: ' + error.message;
            }
            
            res.json({
                success: true,
                user: {
                    kycStatus: user?.kycStatus || 'pending',
                    hasDocuments: !!user?.kycDocuments
                },
                service: {
                    azureEnabled: azureEnabled,
                    hasBlobClient: !!blobServiceClient,
                    containerName: KYC_CONTAINER_NAME,
                    azureStatus: azureStatus
                },
                upload: {
                    maxFileSize: '5MB',
                    allowedFields: ['front', 'back']
                }
            });
        } catch (error) {
            res.json({
                success: false,
                error: error.message
            });
        }
    });

    return router;
};
