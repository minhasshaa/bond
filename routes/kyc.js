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
module.exports = function({ blobServiceClient, KYC_CONTAINER_NAME = 'id-document-uploads', azureEnabled = false }) {
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
            console.log('🔧 KYC Upload Started - Container:', KYC_CONTAINER_NAME);
            
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
            const backFile = req.files.back[0];
            
            console.log('🔧 Files received - Front:', frontFile.originalname, 'Back:', backFile.originalname);

            // 3. Validate file buffers
            if (!frontFile.buffer || !backFile.buffer) {
                console.error("KYC Upload Error: File buffers are empty");
                return res.status(400).json({ 
                    success: false, 
                    message: 'Invalid file data. Please try uploading again.' 
                });
            }

            // 4. Get container client
            const containerClient = blobServiceClient.getContainerClient(KYC_CONTAINER_NAME);
            
            // 5. Check if container exists and is accessible
            try {
                await containerClient.getProperties();
                console.log('✅ Azure container is accessible:', KYC_CONTAINER_NAME);
            } catch (containerError) {
                console.error('❌ Azure container error:', containerError.message);
                if (containerError.statusCode === 404) {
                    throw new Error(`Azure container '${KYC_CONTAINER_NAME}' not found. Please create it in Azure Portal.`);
                } else if (containerError.statusCode === 403) {
                    throw new Error('Azure Storage access denied. Check public access settings.');
                } else {
                    throw containerError;
                }
            }

            // 6. Define secure blob paths
            const frontBlobPath = `user-${userId}/front_${Date.now()}_${frontFile.originalname}`;
            const backBlobPath = `user-${userId}/back_${Date.now()}_${backFile.originalname}`;

            console.log('🔧 Uploading to Azure container:', KYC_CONTAINER_NAME);

            // 7. Upload Files to Azure Blob Storage
            const frontBlobClient = containerClient.getBlockBlobClient(frontBlobPath);
            await frontBlobClient.uploadData(frontFile.buffer, {
                blobHTTPHeaders: { blobContentType: frontFile.mimetype }
            });
            
            const backBlobClient = containerClient.getBlockBlobClient(backBlobPath);
            await backBlobClient.uploadData(backFile.buffer, {
                blobHTTPHeaders: { blobContentType: backFile.mimetype }
            });

            console.log('✅ Azure upload successful to container:', KYC_CONTAINER_NAME);

            // 8. Update User KYC Status in Database
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
                storageType: 'azure',
                container: KYC_CONTAINER_NAME
            };
            user.kycRejectionReason = undefined; 

            await user.save();

            console.log('✅ User KYC status updated to under_review');

            // 9. Send successful response
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
                    serviceStatus: 'disabled'
                });
            }
            
            if (error.message.includes('container') && error.message.includes('not found')) {
                return res.status(503).json({ 
                    success: false, 
                    message: `Azure container '${KYC_CONTAINER_NAME}' not found.`,
                    serviceStatus: 'disabled',
                    solution: `Create container '${KYC_CONTAINER_NAME}' in Azure Portal with public access level 'Blob'`
                });
            }
            
            if (error.message.includes('Public access is not permitted') || error.message.includes('access denied')) {
                return res.status(503).json({ 
                    success: false, 
                    message: 'Azure Storage access denied.',
                    serviceStatus: 'disabled',
                    solution: 'Enable: 1) Allow blob public access, 2) Allow all networks in Azure Storage settings'
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
                message: 'Failed to upload documents. Please try again.',
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
                status: `KYC service is active and connected to Azure container: ${KYC_CONTAINER_NAME}`,
                currentStatus: 'Service connected',
                container: KYC_CONTAINER_NAME
            });

        } catch (error) {
            console.error('KYC Service Status Check Error:', error);
            
            let errorMessage = 'KYC service connection failed';
            
            if (error.statusCode === 404) {
                errorMessage = `Azure container '${KYC_CONTAINER_NAME}' not found`;
            } else if (error.statusCode === 403) {
                errorMessage = 'Azure Storage access denied';
            }
            
            res.json({
                success: true,
                serviceAvailable: false,
                status: `${errorMessage} - ${error.message}`,
                currentStatus: 'Service connection failed',
                container: KYC_CONTAINER_NAME
            });
        }
    });

    return router;
};
