const express = require('express');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const NodeCache = require('node-cache');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 9000; // Netlify functions default port
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const INGRAM_API_URL = 'https://api.ingrammicro.com:443/resellers/v6';
const INGRAM_CLIENT_ID = process.env.INGRAM_CLIENT_ID;
const INGRAM_CLIENT_SECRET = process.env.INGRAM_CLIENT_SECRET;
const INGRAM_CUSTOMER_NUMBER = process.env.INGRAM_CUSTOMER_NUMBER;

// Neon database configuration
const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
});

// Initialize cache (30-minute TTL)
const cache = new NodeCache({ stdTTL: 1800 });

// Middleware
app.use(cors({ origin: 'https://your-netlify-frontend.netlify.app' })); // Update with frontend URL
app.use(express.json());

// Obtain OAuth 2.0 access token
async function getAccessToken() {
  try {
    const cacheKey = 'ingram_access_token';
    let token = cache.get(cacheKey);
    if (token) return token;

    const response = await axios.post('https://api.ingrammicro.com:443/oauth/oauth20/token', {
      grant_type: 'client_credentials',
      client_id: INGRAM_CLIENT_ID,
      client_secret: INGRAM_CLIENT_SECRET
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    token = response.data.access_token;
    cache.set(cacheKey, token, response.data.expires_in - 60);
    return token;
  } catch (error) {
    console.error('Error fetching Ingram Micro access token:', error.message);
    throw error;
  }
}

// Fetch product data from Ingram Micro Price and Availability API
async function fetchProductData(sku = '') {
  try {
    const token = await getAccessToken();
    const response = await axios.post(`${INGRAM_API_URL}/catalog/priceandavailability`, {
      requestpreamble: {
        isocountrycode: 'US',
        customernumber: INGRAM_CUSTOMER_NUMBER
      },
      products: sku ? [{ ingrampartnumber: sku }] : []
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'IM-CustomerNumber': INGRAM_CUSTOMER_NUMBER,
        'IM-CountryCode': 'US',
        'IM-CorrelationID': `vcron-${Date.now()}`
      }
    });
    const products = response.data.serviceresponse?.products || [];
    return products.map(product => ({
      sku: product.ingrampartnumber,
      partNumber: product.vendorpartnumber,
      name: product.description,
      brand: product.vendorname,
      price: product.quotePrice || product.unitprice,
      stock: product.totalavailability
    }));
  } catch (error) {
    console.error('Error fetching Ingram Micro products:', error.message);
    return [];
  }
}

// Periodic cache update
async function updateProductCache() {
  const products = await fetchProductData();
  cache.set('products', products);
  console.log('Product cache updated');
}
setInterval(updateProductCache, 1800 * 1000); // Update every 30 minutes

// Login endpoint
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = { id: 1, email: 'customer@vcronglobal.com', password: 'securepassword' };
  if (email === user.email && password === user.password) {
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Middleware to verify JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// Endpoint for product listings
app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const { sku, brand, category } = req.query;
    let products = cache.get('products');
    if (!products) {
      products = await fetchProductData(sku);
      cache.set('products', products);
    }
    let filteredProducts = products;
    if (sku) filteredProducts = filteredProducts.filter(p => p.sku.includes(sku));
    if (brand) filteredProducts = filteredProducts.filter(p => p.brand.toLowerCase() === brand.toLowerCase());
    if (category) filteredProducts = filteredProducts.filter(p => p.category?.toLowerCase() === category.toLowerCase());
    res.json(filteredProducts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Endpoint to create a quote
app.post('/api/quotes', authenticateToken, async (req, res) => {
  try {
    const { products, shippingInfo, taxInfo } = req.body;
    const token = await getAccessToken();
    const quoteResponse = await axios.post(`${INGRAM_API_URL}/quotes`, {
      requestpreamble: {
        isocountrycode: 'US',
        customernumber: INGRAM_CUSTOMER_NUMBER
      },
      quoteName: `VcronQuote-${Date.now()}`,
      products: products.map(p => ({
        ingrampartnumber: p.sku,
        quantity: p.quantity
      }))
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'IM-CustomerNumber': INGRAM_CUSTOMER_NUMBER,
        'IM-CountryCode': 'US',
        'IM-CorrelationID': `vcron-quote-${Date.now()}`
      }
    });
    const quote = {
      ingramQuoteNumber: quoteResponse.data.quoteNumber,
      userId: req.user.userId,
      products,
      shippingInfo: shippingInfo || 'Pending',
      taxInfo: taxInfo || 'Pending',
      status: 'Pending Approval',
      createdAt: new Date()
    };
    const result = await pool.query(
      'INSERT INTO quotes (ingram_quote_number, user_id, products, shipping_info, tax_info, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [quote.ingramQuoteNumber, quote.userId, JSON.stringify(quote.products), quote.shippingInfo, quote.taxInfo, quote.status, quote.createdAt]
    );
    res.json({ quoteId: result.rows[0].id, ingramQuoteNumber: quote.ingramQuoteNumber, message: 'Quote created, pending approval' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create quote' });
  }
});

// Endpoint to approve a quote
app.post('/api/quotes/:id/approve', authenticateToken, async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    const { finalPrice, shippingInfo, taxInfo } = req.body;
    const result = await pool.query(
      'UPDATE quotes SET status = $1, final_price = $2, shipping_info = $3, tax_info = $4 WHERE id = $5 RETURNING *',
      ['Approved', finalPrice || 'TBD', shippingInfo || 'Pending', taxInfo || 'Pending', quoteId]
    );
    const quote = result.rows[0];
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    res.json({ message: 'Quote approved', quote });
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve quote' });
  }
});
//netlify.toml
[functions]
  directory = "."
  netlify.toml

// Export for Netlify functions
module.exports.handler = app; 
