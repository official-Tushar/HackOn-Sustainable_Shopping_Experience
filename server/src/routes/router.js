// Libraries
const router = require('express').Router();
const Product = require('../models/Product');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const authenticate = require('../middleware/authenticate');
const { check, validationResult } = require('express-validator');
const Challenge = require('../models/Challenge');
const axios = require("axios");
require('dotenv').config({ path: '../../.env' });
const COHERE_API_KEY = process.env.COHERE_API_KEY;

const groupModel = require('../models/group');
const notificationModel = require('../models/groupBuyNotification');
const { NewGroupNotification, UpdateLocationNotification } = require('../socket/notification');

// GET: All products
router.get("/products", async (req, res) => {
  try {
    const productsData = await Product.find();
    res.status(200).json(productsData);
  } catch (error) {
    console.error("Fetch all products error:", error);
    res.status(500).json({ status: false, message: "Failed to fetch products" });
  }
});

// GET: Product by id
router.get("/product/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let individualData;

    // Only use MongoDB _id for lookup
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      individualData = await Product.findById(id);
    }

    if (!individualData) {
      return res.status(404).json({ status: false, message: "Product not found" });
    }

    res.status(200).json(individualData);
  } catch (error) {
    console.error("Fetch individual product error:", error);
    res.status(500).json({ status: false, message: "Error fetching product", error: error.message });
  }
});

// POST: Register user
// Register route with uniqueness handled by MongoDB
router.post('/register', [

  check('name')
    .not().isEmpty().withMessage("Name can't be empty")
    .trim().escape(),

  check('number')
    .not().isEmpty().withMessage("Number can't be empty")
    .isNumeric().withMessage("Number must only consist of digits")
    .isLength({ max: 10, min: 10 }).withMessage('Number must consist of 10 digits'),

  check('password')
    .not().isEmpty().withMessage("Password can't be empty")
    .isLength({ min: 8 }).withMessage("Password must be at least 8 characters long")
    .matches(/[a-z]/).withMessage("Password must contain a lowercase letter")
    .matches(/[A-Z]/).withMessage("Password must contain an uppercase letter")
    .matches(/[0-9]/).withMessage("Password must contain a number")
    .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage("Password must contain a special character"),

  check('email')
    .not().isEmpty().withMessage("Email can't be empty")
    .isEmail().withMessage("Email format is invalid")
    .normalizeEmail()

], async function(req, res) {
  const validationErrors = validationResult(req);
  if (!validationErrors.isEmpty()) {
    return res.status(400).json({
      status: false,
      message: validationErrors.array()
    });
  }

  const { name, number, email, password } = req.body;
  const customErrors = [];

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      name,
      number,
      email,
      password: hashedPassword,
      carbonSaved: 0,
      ecoScore: 0,
      circularityScore: 0,
      moneySaved: 0,
      currentChallenges: [],
      badges: []
    });

    const savedUser = await newUser.save();

    res.status(201).json({
  status: true,
  message: "User registered successfully",
  user: savedUser // optional
});

  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const msg = `${field.charAt(0).toUpperCase() + field.slice(1)} already registered`;
      return res.status(400).json({
        status: false,
        message: [{ msg }]
      });
    }

    console.log(error);
    return res.status(500).json({
      status: false,
      message: "Internal server error"
    });
  }
});


// POST: Login
router.post('/login', [
  check('email')
    .notEmpty().withMessage("Email can't be empty")
    .isEmail().withMessage("Email format is invalid")
    .normalizeEmail(),

  check('password')
    .notEmpty().withMessage("Password can't be empty")
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      status: false, 
      message: errors.array() 
    });
  }

  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ 
        status: false, 
        message: [{ msg: "Incorrect Email or Password" }] 
      });
    }


    const token = await user.generateAuthToken();
    res.cookie("AmazonClone", token, {
      expires: new Date(Date.now() + 3600000),
      httpOnly: true
    });

    res.status(201).json({ 
      status: true, 
      message: "Logged in successfully!" 
    });

  } catch (err) {

    console.error("Login error:", err);
    res.status(500).json({ 
      status: false, 
      message: [{ msg: "Internal server error" }] 
    });
  }
});

// POST: Add to cart
router.post('/addtocart/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    let product = id.match(/^[0-9a-fA-F]{24}$/)
      ? await Product.findById(id)
      : null;

    if (!product) {
      return res.status(404).json({ status: false, message: "Product not found" });
    }

    // Use _id for cart item
    const user = await User.findById(req.userId);
    const cartItem = user.cart.find(item => item.id == product._id.toString());
    if (cartItem) {
      return res.status(400).json({ status: false, message: "Product already in cart" });
    }
    await user.addToCart(product._id.toString(), product);
    res.status(200).json({ status: true, message: "Product added to cart" });
  } catch (error) {
    console.error("Add to cart error:", error);
    res.status(500).json({ status: false, message: "Failed to add to cart" });
  }
});

// DELETE: Remove item from cart
router.delete("/delete/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(req.userId);
    user.cart = user.cart.filter(item => String(item.cartItem._id) !== String(id));
    await user.save();

    res.status(201).json({ status: true, message: "Item deleted successfully" });
  } catch (err) {
    console.error("Delete item error:", err);
    res.status(400).json({ status: false, message: err.message });
  }
});

// GET: Logout
router.get("/logout", authenticate, async (req, res) => {
  try {
    req.rootUser.tokens = req.rootUser.tokens.filter(tokenObj => tokenObj.token !== req.token);
    res.clearCookie("AmazonClone");
    await req.rootUser.save();
    res.status(201).json({ status: true, message: "Logged out successfully!" });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(400).json({ status: false, message: err.message });
  }
});

// GET: Authenticated user
router.get('/getAuthUser', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    res.status(200).json(user);
  } catch (err) {
    console.error("Get auth user error:", err);
    res.status(500).json({ status: false, message: "Failed to fetch user" });
  }
});

// GET: User's order history
router.get('/orders', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ status: false, message: "User not found" });
    }

    // Flatten orders if they are stored as { orderInfo: { ... } }
    const orders = user.orders
      .map(order => order.orderInfo ? { ...order.orderInfo, _id: order._id } : order)
      .reverse();

    res.status(200).json({ 
      status: true,
      orders: orders 
    });
  } catch (error) {
    console.error("Fetch orders error:", error);
    res.status(500).json({ 
      status: false, 
      message: "Failed to fetch orders",
      error: error.message 
    });
  }
});

// GET: Search products by query
router.get("/products/search", async (req, res) => {
  try {
    const query = req.query.query || "";
    
    const results = await Product.find({
      name: { $regex: query, $options: 'i' } // case-insensitive search
    });

    res.status(200).json(results);
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ status: false, message: "Search failed" });
  }
});

// GET: All challenges
router.get('/challenges', async (req, res) => {
  try {
    const challenges = await Challenge.find({ isActive: true });
    res.status(200).json(challenges);
  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to fetch challenges' });
  }
});

// POST: Join a challenge
router.post('/challenges/join/:challengeId', authenticate, async (req, res) => {
  try {
    const { challengeId } = req.params;
    const user = await User.findById(req.userId);
    if (!user.currentChallenges.includes(challengeId)) {
      user.currentChallenges.push(challengeId);
      await user.save();
    }
    res.status(200).json({ status: true, message: 'Challenge joined', currentChallenges: user.currentChallenges });
  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to join challenge' });
  }
});

// POST: Complete a challenge
router.post('/challenges/complete/:challengeId', authenticate, async (req, res) => {
  try {
    const { challengeId } = req.params;
    const user = await User.findById(req.userId);
    const challenge = await Challenge.findById(challengeId);
    
    if (!challenge) {
      return res.status(404).json({ status: false, message: 'Challenge not found' });
    }
    
    // Check if user has joined the challenge
    if (!user.currentChallenges.includes(challengeId)) {
      return res.status(400).json({ status: false, message: 'You must join the challenge first' });
    }
    
    // Check if already completed
    const alreadyHasBadge = user.badges.some(b => b.challengeId && b.challengeId.toString() === challengeId);
    if (alreadyHasBadge) {
      return res.status(400).json({ status: false, message: 'Challenge already completed' });
    }
    
    // Remove from currentChallenges
    user.currentChallenges = user.currentChallenges.filter(id => id.toString() !== challengeId);
    
    // Create badge with proper structure
    const badge = {
      name: challenge.rewardBadge.name,
      description: challenge.rewardBadge.description,
      iconUrl: challenge.rewardBadge.iconUrl,
      challengeId: challenge._id,
      dateEarned: new Date()
    };
    
    user.badges.push(badge);
    await user.save();
    
    res.status(200).json({ 
      status: true, 
      message: 'Challenge completed and badge awarded', 
      badges: user.badges 
    });
  } catch (error) {
    console.error('Complete challenge error:', error);
    res.status(500).json({ status: false, message: 'Failed to complete challenge' });
  }
});

// POST: Update user location
router.post('/update-location', authenticate, async (req, res) => {
  try {
    const { city, state, country, pin, coor } = req.body;
    const userId = req.userId;
    const [latStr, lngStr] = coor.split(',');
    const latitude = parseFloat(latStr);
    const longitude = parseFloat(lngStr);

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ message: 'Invalid coordinates format' });
    }

    const user = await User.findById(userId);
    user.location = { city, state, country, pin, coor: { type: 'Point', coordinates: [longitude, latitude] } };
    await user.save();

    await UpdateLocationNotification({ userId, latitude, longitude, pin });

    let notification = await notificationModel.find({ receiver: userId, isRead: false });

    res.status(200).json({ status: true, message: 'Location updated', location: user.location, notification: notification });
  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to update location' });
  }
});

// POST: Direct order (Buy Now)
router.post('/order/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    let product = id.match(/^[0-9a-fA-F]{24}$/)
      ? await Product.findById(id)
      : await Product.findOne({ id: parseInt(id) });

    if (!product) {
      return res.status(404).json({ status: false, message: 'Product not found' });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(400).json({ status: false, message: 'Invalid User' });
    }

    // Create order object with proper eco-friendly flags and consistent structure
    const orderInfo = {
      items: [{
        name: product.name,
        quantity: 1,
        price: product.price,
        carbonFootprint: product.carbonFootprint || 0,
        ecoScore: product.ecoScore || 0,
        isEcoFriendly: product.isEcoFriendly || (product.ecoScore && product.ecoScore > 0)
      }],
      totalAmount: product.price,
      totalEcoScore: product.ecoScore || 0,
      totalCarbonSaved: product.carbonFootprint || 0,
      moneySaved: 0,
      orderDate: new Date(),
      date: new Date(), // Add both date and orderDate for consistency
      status: 'completed',
      // Add summary information for easy display
      summary: {
        name: product.name,
        price: product.price,
        carbonFootprint: product.carbonFootprint || 0,
        date: new Date(),
        status: 'completed'
      },
      // Add eco-friendly flags for challenge tracking
      isEcoFriendly: product.isEcoFriendly || (product.ecoScore && product.ecoScore > 0),
      ecoScore: product.ecoScore || 0,
      carbonFootprint: product.carbonFootprint || 0
    };
    
    user.orders.push({ orderInfo });
    user.carbonSaved += product.carbonFootprint || 0;
    user.ecoScore = (user.ecoScore + (product.ecoScore || 0)) / 2; // Average of current and new eco score
    
    // Auto-join all active challenges
    const activeChallenges = await Challenge.find({ isActive: true });
    activeChallenges.forEach(challenge => {
      const challengeId = challenge._id.toString();
      if (!user.currentChallenges.map(String).includes(challengeId)) {
        user.currentChallenges.push(challengeId);
      }
    });

    // Check for automatic challenge completion
    await checkAndCompleteChallenges(user, orderInfo);
    
    await user.save();
    res.status(201).json({ status: true, message: 'Order placed successfully', user });
  } catch (error) {
    console.error('Order error:', error);
    res.status(500).json({ status: false, message: 'Failed to place order' });
  }
});

// POST: Create order
router.post('/orders', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ status: false, message: "User not found" });
    }

    if (user.cart.length === 0) {
      return res.status(400).json({ status: false, message: "Cart is empty" });
    }

    const { items, totalAmount, totalEcoScore, totalCarbonSaved, moneySaved } = req.body;

    // Create order object with detailed information and eco-friendly flags
    const orderInfo = {
      items: items.map(item => ({
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        carbonFootprint: item.carbonFootprint || 0,
        ecoScore: item.ecoScore || 0,
        isEcoFriendly: item.isEcoFriendly || (item.ecoScore && item.ecoScore > 0)
      })),
      totalAmount,
      totalEcoScore,
      totalCarbonSaved,
      moneySaved,
      orderDate: new Date(),
      date: new Date(), // Add both date and orderDate for consistency
      status: 'completed',
      // Add summary information for easy display
      summary: {
        name: items[0].name + (items.length > 1 ? ` +${items.length - 1} more items` : ''),
        price: totalAmount,
        carbonFootprint: totalCarbonSaved,
        date: new Date(),
        status: 'completed'
      },
      // Add eco-friendly flags for challenge tracking
      isEcoFriendly: items.some(item => item.isEcoFriendly || (item.ecoScore && item.ecoScore > 0)),
      ecoScore: totalEcoScore,
      carbonFootprint: totalCarbonSaved
    };

    // Update user stats
    user.ecoScore = (user.ecoScore + totalEcoScore) / 2; // Average of current and new eco score
    user.carbonSaved += totalCarbonSaved;
    user.moneySaved += moneySaved;

    // Add order to user's orders
    await user.addOrder(orderInfo);

    // Clear cart
    user.cart = [];

    // Check for automatic challenge completion
    await checkAndCompleteChallenges(user, orderInfo);

    // Save updated user
    await user.save();

    res.status(201).json({
      status: true,
      message: "Order placed successfully",
      order: orderInfo
    });

  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({
      status: false,
      message: "Failed to create order",
      error: error.message
    });
  }
});

// Helper function to check and complete challenges automatically
async function checkAndCompleteChallenges(user, orderInfo) {
  try {
    const now = new Date();
    const activeChallenges = await Challenge.find({ isActive: true });
    
    for (const challenge of activeChallenges) {
      const challengeId = challenge._id.toString();
      
      // Skip if user is not joined or already completed
      if (!user.currentChallenges.includes(challengeId) || 
          user.badges.some(b => b.challengeId && b.challengeId.toString() === challengeId)) {
        continue;
      }

      let shouldComplete = false;
      
      if (challenge.frequency === 'daily') {
        // Check if user bought at least 1 eco-friendly product today
        const todayOrders = user.orders.filter(order => {
          const orderDate = new Date(order.orderInfo?.date || order.orderInfo?.orderDate);
          const isToday = orderDate.getDate() === now.getDate() &&
                         orderDate.getMonth() === now.getMonth() &&
                         orderDate.getFullYear() === now.getFullYear();
          
          // Check if order is eco-friendly using multiple criteria
          const isEco = order.orderInfo?.isEcoFriendly === true || 
                       (order.orderInfo?.ecoScore && order.orderInfo.ecoScore > 0) ||
                       (order.orderInfo?.items && order.orderInfo.items.some(item => 
                         item.isEcoFriendly === true || (item.ecoScore && item.ecoScore > 0)
                       ));
          
          return isToday && isEco;
        });
        shouldComplete = todayOrders.length >= 1;
        
      } else if (challenge.frequency === 'weekly') {
        // Check if user saved at least 5kg CO2 this week
        const day = now.getDay();
        const diffToMonday = (day === 0 ? -6 : 1) - day;
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() + diffToMonday);
        weekStart.setHours(0, 0, 0, 0);
        
        let weeklyCo2Saved = 0;
        user.orders.forEach(order => {
          const orderDate = new Date(order.orderInfo?.date || order.orderInfo?.orderDate);
          if (orderDate >= weekStart && orderDate <= now) {
            // Try multiple possible fields for carbon footprint
            const carbonFootprint = order.orderInfo?.carbonFootprint || 
                                   order.orderInfo?.totalCarbonSaved ||
                                   order.orderInfo?.summary?.carbonFootprint ||
                                   0;
            weeklyCo2Saved += carbonFootprint;
          }
        });
        shouldComplete = weeklyCo2Saved >= 5;
        
      } else if (challenge.frequency === 'monthly') {
        // Check if user bought at least 10 eco-friendly products this month
        const monthlyOrders = user.orders.filter(order => {
          const orderDate = new Date(order.orderInfo?.date || order.orderInfo?.orderDate);
          const isThisMonth = orderDate.getMonth() === now.getMonth() &&
                             orderDate.getFullYear() === now.getFullYear();
          
          // Check if order is eco-friendly using multiple criteria
          const isEco = order.orderInfo?.isEcoFriendly === true || 
                       (order.orderInfo?.ecoScore && order.orderInfo.ecoScore > 0) ||
                       (order.orderInfo?.items && order.orderInfo.items.some(item => 
                         item.isEcoFriendly === true || (item.ecoScore && item.ecoScore > 0)
                       ));
          
          return isThisMonth && isEco;
        });
        shouldComplete = monthlyOrders.length >= 10;
      }

      if (shouldComplete) {
        // Complete the challenge
        user.currentChallenges = user.currentChallenges.filter(id => id.toString() !== challengeId);
        
        // Create badge with proper structure
        const badge = {
          name: challenge.rewardBadge.name,
          description: challenge.rewardBadge.description,
          iconUrl: challenge.rewardBadge.iconUrl,
          challengeId: challenge._id,
          dateEarned: new Date()
        };
        
        user.badges.push(badge);
        console.log(`Challenge ${challenge.name} completed automatically for user ${user.name}`);
      }
    }
  } catch (error) {
    console.error('Error checking challenges:', error);
  }
}

// Leaderboard by badge points
router.get('/leaderboard', async (req, res) => {
  try {
    const users = await User.find({}, 'name badges').lean();
    const badgePoints = { daily: 10, weekly: 50, monthly: 100 };
    const leaderboard = users.map(user => {
      let points = 0;
      user.badges?.forEach(badge => {
        if (badge.name?.toLowerCase().includes('daily')) points += badgePoints.daily;
        else if (badge.name?.toLowerCase().includes('weekly')) points += badgePoints.weekly;
        else if (badge.name?.toLowerCase().includes('monthly')) points += badgePoints.monthly;
      });
      return {
        name: user.name,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}`,
        points,
      };
    }).sort((a, b) => b.points - a.points).slice(0, 20);
    res.status(200).json(leaderboard);
  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to fetch leaderboard' });
  }
});


// POST: Check and complete challenges for existing orders
router.post('/challenges/check-completion', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ status: false, message: 'User not found' });
    }

    const now = new Date();
    const activeChallenges = await Challenge.find({ isActive: true });
    let completedChallenges = [];

    for (const challenge of activeChallenges) {
      const challengeId = challenge._id.toString();
      
      // Skip if user is not joined or already completed
      if (!user.currentChallenges.includes(challengeId) || 
          user.badges.some(b => b.challengeId && b.challengeId.toString() === challengeId)) {
        continue;
      }

      let shouldComplete = false;
      
      if (challenge.frequency === 'daily') {
        // Check if user bought at least 1 eco-friendly product today
        const todayOrders = user.orders.filter(order => {
          const orderDate = new Date(order.orderInfo?.date || order.orderInfo?.orderDate);
          const isToday = orderDate.getDate() === now.getDate() &&
                         orderDate.getMonth() === now.getMonth() &&
                         orderDate.getFullYear() === now.getFullYear();
          
          // Check if order is eco-friendly using multiple criteria
          const isEco = order.orderInfo?.isEcoFriendly === true || 
                       (order.orderInfo?.ecoScore && order.orderInfo.ecoScore > 0) ||
                       (order.orderInfo?.items && order.orderInfo.items.some(item => 
                         item.isEcoFriendly === true || (item.ecoScore && item.ecoScore > 0)
                       ));
          
          return isToday && isEco;
        });
        shouldComplete = todayOrders.length >= 1;
        
      } else if (challenge.frequency === 'weekly') {
        // Check if user saved at least 5kg CO2 this week
        const day = now.getDay();
        const diffToMonday = (day === 0 ? -6 : 1) - day;
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() + diffToMonday);
        weekStart.setHours(0, 0, 0, 0);
        
        let weeklyCo2Saved = 0;
        user.orders.forEach(order => {
          const orderDate = new Date(order.orderInfo?.date || order.orderInfo?.orderDate);
          if (orderDate >= weekStart && orderDate <= now) {
            // Try multiple possible fields for carbon footprint
            const carbonFootprint = order.orderInfo?.carbonFootprint || 
                                   order.orderInfo?.totalCarbonSaved ||
                                   order.orderInfo?.summary?.carbonFootprint ||
                                   0;
            weeklyCo2Saved += carbonFootprint;
          }
        });
        shouldComplete = weeklyCo2Saved >= 5;
        
      } else if (challenge.frequency === 'monthly') {
        // Check if user bought at least 10 eco-friendly products this month
        const monthlyOrders = user.orders.filter(order => {
          const orderDate = new Date(order.orderInfo?.date || order.orderInfo?.orderDate);
          const isThisMonth = orderDate.getMonth() === now.getMonth() &&
                             orderDate.getFullYear() === now.getFullYear();
          
          // Check if order is eco-friendly using multiple criteria
          const isEco = order.orderInfo?.isEcoFriendly === true || 
                       (order.orderInfo?.ecoScore && order.orderInfo.ecoScore > 0) ||
                       (order.orderInfo?.items && order.orderInfo.items.some(item => 
                         item.isEcoFriendly === true || (item.ecoScore && item.ecoScore > 0)
                       ));
          
          return isThisMonth && isEco;
        });
        shouldComplete = monthlyOrders.length >= 10;
      }

      if (shouldComplete) {
        // Complete the challenge
        user.currentChallenges = user.currentChallenges.filter(id => id.toString() !== challengeId);
        
        // Create badge with proper structure
        const badge = {
          name: challenge.rewardBadge.name,
          description: challenge.rewardBadge.description,
          iconUrl: challenge.rewardBadge.iconUrl,
          challengeId: challenge._id,
          dateEarned: new Date()
        };
        
        user.badges.push(badge);
        completedChallenges.push(challenge.name);
        console.log(`Challenge ${challenge.name} completed for user ${user.name}`);
      }
    }

    await user.save();
    
    res.status(200).json({ 
      status: true, 
      message: `Checked challenges. ${completedChallenges.length} challenges completed.`,
      completedChallenges,
      badges: user.badges 
    });
  } catch (error) {
    console.error('Error checking challenges:', error);
    res.status(500).json({ status: false, message: 'Failed to check challenges' });
  }
});

// GET: User profile with challenges and badges
router.get('/user/profile', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .populate('currentChallenges')
      .lean();
    
    if (!user) {
      return res.status(404).json({ status: false, message: 'User not found' });
    }

    // Get active challenges
    const activeChallenges = await Challenge.find({ isActive: true }).lean();
    
    // Calculate user stats
    const totalOrders = user.orders?.length || 0;
    const totalBadges = user.badges?.length || 0;
    const ecoScore = user.ecoScore || 0;
    const carbonSaved = user.carbonSaved || 0;
    
    // Calculate weekly CO2 savings for debug info
    const now = new Date();
    const day = now.getDay();
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() + diffToMonday);
    weekStart.setHours(0, 0, 0, 0);
    
    const weeklyOrders = user.orders?.filter(order => {
      const orderDate = new Date(order.orderInfo?.date || order.orderInfo?.orderDate);
      return orderDate >= weekStart && orderDate <= now;
    }) || [];
    
    const weeklyCo2Saved = weeklyOrders.reduce((sum, order) => {
      const carbonFootprint = order.orderInfo?.carbonFootprint || 
                             order.orderInfo?.totalCarbonSaved ||
                             order.orderInfo?.summary?.carbonFootprint ||
                             0;
      return sum + carbonFootprint;
    }, 0);

    const userProfile = {
      ...user,
      totalOrders,
      totalBadges,
      ecoScore,
      carbonSaved,
      weeklyCo2Saved,
      activeChallenges,
      // Ensure orders have proper structure
      orders: user.orders?.map(order => ({
        ...order,
        orderInfo: {
          ...order.orderInfo,
          date: order.orderInfo?.date || order.orderInfo?.orderDate,
          orderDate: order.orderInfo?.orderDate || order.orderInfo?.date
        }
      })) || []
    };

    res.status(200).json({ 
      status: true, 
      user: userProfile 
    });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ status: false, message: 'Failed to get user profile' });
  }
});

// Helper: Cohere intent detection using generate endpoint
async function getIntentFromCohere(userMessage) {
  const prompt = `You are an assistant that classifies user queries into one of the following:\n\n1. cart_alternative → if the user asks about eco-friendly product replacements or shopping suggestions.\n2. my_challenges → if the user asks about their environmental challenges or progress.\n3. carbon_footprint → if the user asks about their CO2 usage, impact, or monthly footprint.\n4. chat → if the query is general conversation, fun facts, or unrelated.\n\nOnly reply with one of these 4 words exactly.\n\nUser: ${userMessage}\nAssistant:`;
  const data = {
    model: "command",
    prompt,
    max_tokens: 10,
    temperature: 0,
    k: 0,
    stop_sequences: ["\n"],
    return_likelihoods: "NONE"
  };
  const response = await axios.post(
    "https://api.cohere.ai/v1/generate",
    data,
    {
      headers: {
        "Authorization": `Bearer ${COHERE_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
  return response.data.generations[0].text.trim();
}

// Helper: Cohere chat (generate)
async function continueChatWithCohere(userMessage, maxWords = 30) {
  const data = {
    model: "command",
    prompt: `You are Green Partner, a helpful, friendly, and eco-conscious AI assistant for an Amazon-like platform. If the user asks about global sustainability, carbon emissions, or general eco questions (like 'which items in the world generate most carbon'), answer with real-world facts and context, not just platform data. Always answer in a short, concise way (no more than ${maxWords} words). Be positive, supportive, and engaging.\nUser: ${userMessage}\nAssistant:`,
    max_tokens: 80, // adjust as needed
    temperature: 0.7,
    k: 0,
    stop_sequences: ["User:"],
    return_likelihoods: "NONE"
  };
  const response = await axios.post(
    "https://api.cohere.ai/v1/generate",
    data,
    {
      headers: {
        "Authorization": `Bearer ${COHERE_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
  let reply = response.data.generations[0].text.trim();
  // Enforce word limit
  if (reply.split(' ').length > maxWords) {
    reply = reply.split(' ').slice(0, maxWords).join(' ') + '...';
  }
  return reply;
}

// POST: Chat intent detection and routing
router.post('/chat', async (req, res) => {
  const { message, userId } = req.body;
  try {
    let intent = await getIntentFromCohere(message);

    // If the query is about global context, force 'chat' intent
    const globalPhrases = [
      "in the world",
      "globally",
      "worldwide",
      "on earth",
      "across the world",
      "across the globe"
    ];
    if (globalPhrases.some(phrase => message.toLowerCase().includes(phrase))) {
      intent = "chat";
    }

    // Only trigger 'carbon_footprint' for queries about the user's own footprint
    const myFootprintPhrases = [
      "my carbon footprint",
      "my co2",
      "my emissions",
      "my carbon usage",
      "my monthly carbon",
      "my carbon",
      "my footprint"
    ];
    if (intent === "carbon_footprint" && !myFootprintPhrases.some(phrase => message.toLowerCase().includes(phrase))) {
      intent = "chat";
    }

    let reply = "";

    if (["cart_alternative", "my_challenges", "carbon_footprint"].includes(intent) && !userId) {
      return res.status(400).json({ reply: "User ID required for this intent.", intent });
    }

    switch (intent) {
      case "cart_alternative": {
        // Find user's last ordered product's category
        const user = await User.findById(userId);
        if (!user || !user.orders.length) {
          reply = "No recent orders found to suggest alternatives.";
          break;
        }
        // Get last ordered product
        const lastOrder = user.orders[user.orders.length - 1];
        const lastItem = lastOrder.orderInfo.items[0];
        if (!lastItem) {
          reply = "No items found in your last order.";
          break;
        }
        // Find higher ecoScore product in same category
        const category = lastItem.category || "General";
        const products = await Product.find({ category });
        const better = products.filter(p => p.ecoScore > (lastItem.ecoScore || 0));
        if (better.length) {
          const best = better.sort((a, b) => b.ecoScore - a.ecoScore)[0];
          reply = `Try switching to ${best.name} (EcoScore: ${best.ecoScore}) for a greener choice!`;
        } else {
          reply = "You're already using one of the best eco-friendly options!";
        }
        break;
      }
      case "carbon_footprint": {
        // Sum item.carbonFootprint for all items in all orders for the current month (support both old and new order structures)
        const user = await User.findById(userId);
        if (!user) {
          reply = "User not found.";
          break;
        }
        const now = new Date();
        const month = now.getMonth();
        const year = now.getFullYear();
        let total = 0;
        const breakdown = [];
        let foundOrder = false;
        user.orders.forEach(order => {
          // Support both new (orderDate) and old (orderInfo.orderDate/date) structures
          const d = order.orderDate || order.date || order.orderInfo?.date || order.orderInfo?.orderDate;
          if (d && new Date(d).getMonth() === month && new Date(d).getFullYear() === year) {
            let orderTotal = 0;
            let items = [];
            if (order.items && order.items.length) {
              // New structure
              items = order.items;
              order.items.forEach(item => {
                orderTotal += item.carbonFootprint || 0;
              });
            } else if (order.orderInfo?.items && order.orderInfo.items.length) {
              // Old structure
              items = order.orderInfo.items;
              order.orderInfo.items.forEach(item => {
                orderTotal += item.carbonFootprint || 0;
              });
            }
            if (orderTotal > 0) foundOrder = true;
            breakdown.push({
              date: d,
              items: items.map(item => ({
                name: item.name,
                carbonFootprint: item.carbonFootprint || 0
              })),
              orderTotal
            });
            total += orderTotal;
          }
        });
        if (!foundOrder) {
          reply = "No carbon footprint data found for this month. Place an order to start tracking your impact!";
          return res.json({ reply, intent, breakdown: [], total: 0 });
        }
        reply = `Your estimated CO₂ saved this month is ${total.toFixed(2)} kg.`;
        console.log(`[carbon_footprint] userId=${userId}, total=${total}, breakdown=`, breakdown);
        return res.json({ reply, intent, breakdown, total });
      }
      case "my_challenges": {
        // List current challenges and badges with details and progress
        const user = await User.findById(userId);
        if (!user) {
          reply = "User not found.";
          break;
        }
        // Get all challenge objects
        const allChallenges = await Challenge.find({});
        const userChallenges = allChallenges.filter(ch => user.currentChallenges.includes(ch._id.toString()) || user.currentChallenges.includes(ch.id));
        const now = new Date();
        const challengeDetails = userChallenges.map(ch => {
          let progress = 0;
          let target = ch.targetValue;
          let progressText = '';
          let completed = user.badges.some(b => b.challengeId?.toString() === ch._id.toString());
          if (completed) {
            progress = target;
            progressText = 'Completed!';
          } else if (ch.frequency === 'weekly') {
            // Weekly: sum CO2 saved this week
            const day = now.getDay();
            const diffToMonday = (day === 0 ? -6 : 1) - day;
            const weekStart = new Date(now);
            weekStart.setDate(now.getDate() + diffToMonday);
            weekStart.setHours(0, 0, 0, 0);
            let co2Saved = 0;
            user.orders.forEach(order => {
              const orderDate = new Date(order.orderInfo?.date || order.orderInfo?.orderDate);
              if (orderDate >= weekStart && orderDate <= now) {
                const carbonFootprint = order.orderInfo?.carbonFootprint || order.orderInfo?.totalCarbonSaved || order.orderInfo?.summary?.carbonFootprint || 0;
                co2Saved += carbonFootprint;
              }
            });
            progress = co2Saved;
            progressText = `CO₂ saved this week: ${co2Saved.toFixed(2)}/${target} kg`;
          } else if (ch.frequency === 'daily' || ch.frequency === 'monthly') {
            // Daily/Monthly: count eco-friendly products bought today/this month
            let ecoCount = 0;
            user.orders.forEach(order => {
              const orderDate = new Date(order.orderInfo?.date || order.orderInfo?.orderDate);
              const isEco = order.orderInfo?.isEcoFriendly === true ||
                (order.orderInfo?.ecoScore && order.orderInfo.ecoScore > 0) ||
                (order.orderInfo?.items && order.orderInfo.items.some(item => item?.isEcoFriendly === true || (item?.ecoScore && item.ecoScore > 0)));
              if (ch.frequency === 'daily') {
                if (
                  orderDate.getDate() === now.getDate() &&
                  orderDate.getMonth() === now.getMonth() &&
                  orderDate.getFullYear() === now.getFullYear() &&
                  isEco
                ) {
                  ecoCount++;
                }
                target = 1;
                progressText = `Eco-friendly products bought today: ${ecoCount}/1`;
                progress = ecoCount;
              } else if (ch.frequency === 'monthly') {
                if (
                  orderDate.getMonth() === now.getMonth() &&
                  orderDate.getFullYear() === now.getFullYear() &&
                  isEco
                ) {
                  ecoCount++;
                }
                target = 10;
                progressText = `Eco-friendly products bought this month: ${ecoCount}/10`;
                progress = ecoCount;
              }
            });
          } else {
            // Fallback for other types
            progress = 0;
            progressText = '';
          }
          return {
            id: ch._id,
            name: ch.name,
            description: ch.description,
            frequency: ch.frequency,
            type: ch.type,
            targetValue: target,
            rewardBadge: ch.rewardBadge,
            isActive: ch.isActive,
            startDate: ch.startDate,
            endDate: ch.endDate,
            status: completed ? 'completed' : 'active',
            progress,
            target,
            progressText
          };
        });
        const badges = user.badges || [];
        reply = `Here are your current challenges and badges!`;
        return res.json({ reply, intent, challenges: challengeDetails, badges });
      }
      case "chat":
      default:
        reply = await continueChatWithCohere(message, 30); // 30 words max
    }
    res.json({ reply, intent });
  } catch (err) {
    console.error("/chat error:", err);
    if (err.response) {
      console.error("Cohere API error response:", err.response.data);
    }
    res.status(500).json({ reply: "Something went wrong.", intent: null, error: err.stack });
  }
});




router.post('/create-group', authenticate, async(req, res) => {
  try {
    const userId = req.userId;
    const rootUser = req.rootUser;
    const { groupName, date } = req.body;

    let data = new groupModel({ name: groupName, date: date, members: [{ userId: userId, item: [] }] });
    data = await data.save();

    await User.findByIdAndUpdate( userId, { $addToSet: { PendingGroup: data._id } } );

    const [lng, lat] = rootUser.location.coor.coordinates;
    const pin = rootUser.location.pin;
    await NewGroupNotification({ sender: rootUser, groupId: data._id, latitude: lat, longitude: lng, pincode: pin,  message: `${rootUser.name} created a new group near you!` });

    data = await User.findById(userId).populate({
      path: 'PendingGroup',
      populate: [ 
        { path: 'members.userId', model: 'users' },
        { path: 'members.item.product', model: 'products' }
      ]
    });

    res.status(200).json({ status: true, message: 'Group created successfully', data: data });
  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to create group' });
  }
});


router.post('/join-group/:groudId', authenticate, async(req, res) => {
  try {
    const userId = req.userId;
    const { groupId } = req.params;

    await groupModel.findByIdAndUpdate( groupId, { $addToSet: { members: { userId: userId, item: [] } } }, { new: true })
    await User.findByIdAndUpdate( userId, { $addToSet: { PendingGroup: groupId } } );

    res.status(200).json({ status: true, message: 'Group joined successfully' });
  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to join group' });
  }
});


router.post('/exit-group/:groupId', authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    const { groupId } = req.params;

    // 1. Remove user from group.members
    await groupModel.findByIdAndUpdate( groupId, { $pull: { members: { userId: userId } } } );

    // 2. Remove groupId from user's PendingGroup list
    await User.findByIdAndUpdate( userId, { $pull: { PendingGroup: groupId } } );

    res.status(200).json({ status: true, message: 'Exited group successfully' });
  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to exit group', error: error.message });
  }
});


router.put('/update-group/:groupId', authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { groupName, date } = req.body;

    const updatedGroup = await groupModel.findByIdAndUpdate( groupId,
      { $set: { name: groupName, date: date } },
      { new: true }
    );

    res.status(200).json({ status: true, message: 'Group updated successfully', data: updatedGroup  });
  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to update group', error: error.message });
  }
});



router.get('/pending-group', authenticate, async (req, res) => {
  try {
    const userId = req.userId;

    const data = await User.findById(userId).populate({
      path: 'PendingGroup',
      populate: [ 
        { path: 'members.userId', model: 'users' },
        { path: 'members.item.product', model: 'products' }
      ]
    });

    res.status(200).json({ status: true, data });
  } catch (error) {
    console.error('Error fetching pending group:', error);
    res.status(500).json({ status: false, message: 'Failed to fetch group data' });
  }
});


router.post('/add-item/group/:groupId', authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.userId;
    const { productId, count } = req.body;

    const result = await groupModel.findOneAndUpdate(
      {_id: groupId, 'members.userId': userId },
      { $push: { 'members.$.item': { product: productId, count: count } } }, { new: true } ).
      populate({ path: 'members.item.product', model: 'products' }
    );

    res.status(200).json({ status: true, message: 'Product added to user in group successfully', data: result });

  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to add item to group', error: error.message });
  }
});



router.put('/update-item/group/:groupId', authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.userId;
    const { productId, count } = req.body;

    const result = await groupModel.findOneAndUpdate(
      { _id: groupId, 'members.userId': userId, 'members.item.product': productId },
      { $set: { 'members.$[member].item.$[item].count': count } },
      { arrayFilters: [ { 'member.userId': userId }, { 'item.product': productId } ], new: true }
    ).populate({
      path: 'members.item.product', model: 'products'
    });

    res.status(200).json({ status: true, message: 'Product count updated successfully', data: result });

  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to update item', error: error.message });
  }
});


router.delete('/remove-item/group/:groupId', authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.userId;
    const { productId } = req.body;

    const result = await groupModel.findOneAndUpdate(
      { _id: groupId, 'members.userId': userId },
      { $pull: { 'members.$.item': { product: productId } } },
      { new: true }
    ).populate({ path: 'members.item.product',  model: 'products'  });


    res.status(200).json({ status: true, message: 'Product removed from group successfully', data: result });
  } catch (error) {
    res.status(500).json({ status: false, message: 'Failed to remove item', error: error.message });
  }
});




module.exports = router;
