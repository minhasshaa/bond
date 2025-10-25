// middleware/auth.js

const jwt = require('jsonwebtoken');

// This middleware protects HTTP API routes by checking the JWT in the headers.
module.exports = function (req, res, next) {
    
    // 1. Check for the token in the standard 'x-auth-token' header.
    let token = req.header('x-auth-token'); 
    
    // 2. If not found, check the 'Authorization' header (used by some clients, like your KYC fetch).
    if (!token) {
        const authHeader = req.header('Authorization');
        
        if (authHeader && authHeader.startsWith('Bearer ')) {
            // Extract the token string after the "Bearer " prefix (which is 7 characters long)
            token = authHeader.substring(7);
        }
    }
    
    // 3. If no token is found in either location, deny access.
    if (!token) {
      // Ensure the response is JSON, which the frontend expects on API calls.
      return res.status(401).json({ success: false, msg: 'No token, authorization denied.' });
    }
  
    // 4. Verify the token.
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Attach the decoded user data (e.g., user ID) to the request object.
      req.user = decoded;
      
      // Proceed to the next middleware or route handler.
      next();
      
    } catch (err) {
      // Handle an invalid or expired token.
      console.error('Authentication Error: Invalid token provided.', err.message);
      
      // Ensure the response is JSON for the frontend.
      res.status(401).json({ success: false, msg: 'Token is not valid.' });
    }
};
