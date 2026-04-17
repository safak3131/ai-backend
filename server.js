require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { Pool } = require("pg");
const { v2: cloudinary } = require("cloudinary");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const DATABASE_URL = process.env.DATABASE_URL || "";
const UPLOADS_DIR = path.join(__dirname, "uploads");

const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "";
const APPLE_SHARED_SECRET = process.env.APPLE_SHARED_SECRET || "";

const CREDIT_PRODUCTS = {
  credits_10_old: 10
};

const QUALITY_COSTS = {
  low: 1,
  high: 3
};

if (!DATABASE_URL) {
  console.error("DATABASE_URL env eksik.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || ".jpg");
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

async function runQuery(sql, params = []) {
  return await pool.query(sql, params);
}

async function getQuery(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function allQuery(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function initDatabase() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      is_premium INTEGER NOT NULL DEFAULT 0,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS generations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      motion_type TEXT NOT NULL,
      quality TEXT NOT NULL,
      custom_prompt TEXT,
      final_prompt TEXT,
      negative_prompt TEXT,
      input_image_url TEXT,
      status TEXT NOT NULL,
      output_video_url TEXT,
      error_message TEXT,
      replicate_prediction_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      transaction_id TEXT NOT NULL UNIQUE,
      original_transaction_id TEXT,
      credits_added INTEGER NOT NULL DEFAULT 0,
      environment TEXT,
      raw_signed_transaction TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE INDEX IF NOT EXISTS idx_generations_user_id
    ON generations(user_id)
  `);

  await runQuery(`
    CREATE INDEX IF NOT EXISTS idx_purchases_user_id
    ON purchases(user_id)
  `);
}

const MOTION_PRESETS = {
  cinematic_pan: {
    label: "Cinematic Pan",
    prompt:
      "Camera slowly pans from left to right around the architectural building, realistic lighting, subtle environmental movement, cinematic quality, 4K",
    negativePrompt:
      "different building, redesigned house, altered facade, warped architecture, deformed geometry, extra windows, missing walls, unrealistic motion, shaky camera, low quality, blurry, flicker"
  },
  slow_zoom_in: {
    label: "Slow Zoom In",
    prompt:
      "Slow cinematic zoom toward the architectural building, preserve original structure exactly, subtle environmental motion, realistic lighting, stable composition, high detail",
    negativePrompt:
      "different building, redesigned house, altered facade, warped architecture, structure changes, extra elements, shaky motion, blur, flicker, low quality"
  },
  orbit_camera: {
    label: "Orbit Camera",
    prompt:
      "Camera smoothly orbits around the architectural building, preserve original design, stable structure, cinematic motion, natural lighting, subtle movement in environment",
    negativePrompt:
      "different building, redesigned house, altered facade, warped geometry, unstable structure, camera shake, blur, flicker, low quality"
  },
  drone_flyover: {
    label: "Drone Flyover",
    prompt:
      "Smooth drone flyover around the architectural building, preserve the original building exactly, cinematic aerial motion, realistic environment, stable structure, professional visualization quality",
    negativePrompt:
      "different building, redesigned house, altered facade, warped geometry, unstable building, weird camera path, shaky motion, blur, flicker, low quality"
  }
};

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email
    },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

async function getUserById(id) {
  return await getQuery(`SELECT * FROM users WHERE id = $1`, [id]);
}

async function getUserByEmail(email) {
  return await getQuery(`SELECT * FROM users WHERE email = $1`, [email]);
}

function sanitizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    is_premium: !!user.is_premium,
    credits: user.credits,
    created_at: user.created_at,
    updated_at: user.updated_at
  };
}

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authorization token gerekli."
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Kullanıcı bulunamadı."
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: "Geçersiz veya süresi dolmuş token."
    });
  }
}

function getCreditCostForQuality(quality) {
  if (!QUALITY_COSTS[quality]) {
    throw new Error("Geçersiz quality.");
  }

  return QUALITY_COSTS[quality];
}

async function decrementCredit(userId, amount) {
  const result = await runQuery(
    `UPDATE users
     SET credits = credits - $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND credits >= $3
     RETURNING *`,
    [amount, userId, amount]
  );

  if (result.rowCount === 0) {
    throw new Error("Yetersiz kredi.");
  }

  return result.rows[0];
}

async function addCredits(userId, amount) {
  const result = await runQuery(
    `UPDATE users
     SET credits = credits + $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING *`,
    [amount, userId]
  );

  if (result.rowCount === 0) {
    throw new Error("Kullanıcı bulunamadı.");
  }

  return result.rows[0];
}

async function uploadImageToCloudinary(filePath) {
  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: "image",
    folder: "archvideo"
  });

  if (!result || !result.secure_url) {
    throw new Error("Cloudinary upload failed.");
  }

  return result.secure_url;
}

function buildPrompt(motionType, customPrompt) {
  const preset = MOTION_PRESETS[motionType];

  if (!preset) {
    throw new Error("Geçersiz motionType.");
  }

  if (customPrompt && customPrompt.trim().length > 0) {
    return `${preset.prompt}. Additional direction: ${customPrompt.trim()}`;
  }

  return preset.prompt;
}

function buildNegativePrompt(motionType) {
  const preset = MOTION_PRESETS[motionType];

  if (!preset) {
    throw new Error("Geçersiz motionType.");
  }

  return preset.negativePrompt;
}

function getModelConfig(quality) {
  if (quality === "low") {
    return {
      provider: "wan",
      modelSlug: "wan-video/wan-2.2-i2v-fast",
      maxWaitMs: Number(process.env.WAN_MAX_WAIT_MS || 180000)
    };
  }

  if (quality === "high") {
    return {
      provider: "kling",
      modelSlug: "kwaivgi/kling-v2.5-turbo-pro",
      maxWaitMs: Number(process.env.KLING_MAX_WAIT_MS || 300000)
    };
  }

  throw new Error("quality alanı 'low' veya 'high' olmalı.");
}

async function createReplicatePrediction(quality, imageUrl, prompt, negativePrompt) {
  const modelConfig = getModelConfig(quality);

  let input;

  if (modelConfig.provider === "wan") {
    input = {
      image: imageUrl,
      prompt,
      negative_prompt: negativePrompt,
      resolution: "720p",
      num_frames: 96,
      sample_shift: 8,
      guide_scale: 5.0,
      motion_score: 2,
      interpolate_output: true,
      duration: "5s"
    };
  } else {
    input = {
      start_image: imageUrl,
      prompt,
      negative_prompt: negativePrompt,
      duration: 5,
      aspect_ratio: "16:9"
    };
  }

  const response = await axios.post(
    `https://api.replicate.com/v1/models/${modelConfig.modelSlug}/predictions`,
    { input },
    {
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );

  return {
    provider: modelConfig.provider,
    maxWaitMs: modelConfig.maxWaitMs,
    prediction: response.data
  };
}

async function getReplicatePrediction(predictionUrl) {
  const response = await axios.get(predictionUrl, {
    headers: {
      Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`
    }
  });

  return response.data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPredictionResult(predictionUrl, maxWaitMs) {
  const pollInterval = Number(process.env.POLL_INTERVAL_MS || 3000);
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const prediction = await getReplicatePrediction(predictionUrl);

    if (prediction.status === "succeeded") {
      return prediction;
    }

    if (prediction.status === "failed" || prediction.status === "canceled") {
      return prediction;
    }

    await sleep(pollInterval);
  }

  throw new Error("Prediction timeout oldu.");
}

function normalizeReplicateOutput(output) {
  if (!output) return null;
  if (Array.isArray(output)) return output[0] || null;
  return output;
}

async function updateGenerationStatus(id, data) {
  await runQuery(
    `UPDATE generations
     SET status = $1,
         output_video_url = $2,
         error_message = $3,
         replicate_prediction_id = $4,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $5`,
    [
      data.status || null,
      data.output_video_url || null,
      data.error_message || null,
      data.replicate_prediction_id || null,
      id
    ]
  );
}

async function getPurchaseByTransactionId(transactionId) {
  return await getQuery(
    `SELECT * FROM purchases WHERE transaction_id = $1`,
    [transactionId]
  );
}

async function verifyReceiptWithApple(receiptData) {
  if (!APPLE_SHARED_SECRET) {
    throw new Error("APPLE_SHARED_SECRET env eksik.");
  }

  const prodResponse = await axios.post(
    "https://buy.itunes.apple.com/verifyReceipt",
    {
      "receipt-data": receiptData,
      password: APPLE_SHARED_SECRET,
      "exclude-old-transactions": true
    },
    {
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );

  if (prodResponse.data?.status === 21007) {
    const sandboxResponse = await axios.post(
      "https://sandbox.itunes.apple.com/verifyReceipt",
      {
        "receipt-data": receiptData,
        password: APPLE_SHARED_SECRET,
        "exclude-old-transactions": true
      },
      {
        headers: {
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    return {
      environment: "sandbox",
      data: sandboxResponse.data
    };
  }

  return {
    environment: "production",
    data: prodResponse.data
  };
}

function pickMatchingReceiptItem(verifyData, productId) {
  const latest = Array.isArray(verifyData.latest_receipt_info)
    ? verifyData.latest_receipt_info
    : [];

  const inApp = Array.isArray(verifyData.receipt?.in_app)
    ? verifyData.receipt.in_app
    : [];

  const merged = [...latest, ...inApp].filter(
    (item) => item && item.product_id === productId && item.transaction_id
  );

  if (merged.length === 0) {
    return null;
  }

  merged.sort((a, b) => {
    const aTime = Number(a.purchase_date_ms || 0);
    const bTime = Number(b.purchase_date_ms || 0);
    return bTime - aTime;
  });

  return merged[0];
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "ArchVideo backend çalışıyor."
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "email ve password gerekli."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: "Şifre en az 6 karakter olmalı."
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await getUserByEmail(normalizedEmail);

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: "Bu email zaten kayıtlı."
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await runQuery(
      `INSERT INTO users (email, password_hash, full_name, is_premium, credits)
       VALUES ($1, $2, $3, 0, 0)
       RETURNING *`,
      [normalizedEmail, passwordHash, full_name || null]
    );

    const user = result.rows[0];
    const token = createToken(user);

    return res.json({
      success: true,
      token,
      user: sanitizeUser(user)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "email ve password gerekli."
      });
    }

    const user = await getUserByEmail(email.trim().toLowerCase());

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Email veya şifre hatalı."
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: "Email veya şifre hatalı."
      });
    }

    const token = createToken(user);

    return res.json({
      success: true,
      token,
      user: sanitizeUser(user)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  return res.json({
    success: true,
    user: sanitizeUser(req.user)
  });
});

app.post("/api/purchase/verify", authMiddleware, async (req, res) => {
  try {
    const { receiptData, productId } = req.body;

    console.log("📦 Incoming purchase request");
    console.log("receiptData exists:", !!receiptData);
    console.log("productId from client:", productId);
    console.log("APPLE_BUNDLE_ID:", APPLE_BUNDLE_ID);
    console.log("APPLE_SHARED_SECRET exists:", !!APPLE_SHARED_SECRET);

    if (!receiptData || !productId) {
      return res.status(400).json({
        success: false,
        error: "receiptData ve productId gerekli."
      });
    }

    if (!CREDIT_PRODUCTS[productId]) {
      return res.status(400).json({
        success: false,
        error: "Geçersiz productId."
      });
    }

    const { environment, data } = await verifyReceiptWithApple(receiptData);

    console.log("🍎 Apple verify response:", JSON.stringify(data, null, 2));

    if (data.status !== 0) {
      return res.status(400).json({
        success: false,
        error: "Apple doğrulama başarısız.",
        appleStatus: data.status
      });
    }

    const receiptBundleId = data.receipt?.bundle_id;

    console.log("📱 Receipt bundle id:", receiptBundleId);

    if (!receiptBundleId) {
      return res.status(400).json({
        success: false,
        error: "Receipt bundle_id bulunamadı."
      });
    }

    if (receiptBundleId !== APPLE_BUNDLE_ID) {
      return res.status(400).json({
        success: false,
        error: "Bundle ID uyuşmuyor."
      });
    }

    const matchedItem = pickMatchingReceiptItem(data, productId);

    console.log("🎯 matchedItem:", matchedItem);

    if (!matchedItem) {
      return res.status(400).json({
        success: false,
        error: "Bu productId için geçerli satın alma kaydı bulunamadı."
      });
    }

    const transactionId = String(matchedItem.transaction_id);
    const originalTransactionId = matchedItem.original_transaction_id
      ? String(matchedItem.original_transaction_id)
      : null;

    console.log("🧾 transactionId:", transactionId);
    console.log("🧾 originalTransactionId:", originalTransactionId);

    const existingPurchase = await getPurchaseByTransactionId(transactionId);

    if (existingPurchase) {
      console.log("♻️ Purchase already processed:", transactionId);

      const user = await getUserById(req.user.id);

      return res.json({
        success: true,
        alreadyProcessed: true,
        user: sanitizeUser(user)
      });
    }

    const creditsToAdd = CREDIT_PRODUCTS[productId];

    console.log("💰 creditsToAdd:", creditsToAdd);

    await runQuery(
      `INSERT INTO purchases (
        user_id,
        product_id,
        transaction_id,
        original_transaction_id,
        credits_added,
        environment,
        raw_signed_transaction
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        productId,
        transactionId,
        originalTransactionId,
        creditsToAdd,
        environment,
        receiptData
      ]
    );

    const updatedUser = await addCredits(req.user.id, creditsToAdd);

    console.log("✅ Credits added. New balance:", updatedUser?.credits);

    return res.json({
      success: true,
      creditsAdded: creditsToAdd,
      productId,
      transactionId,
      environment,
      user: sanitizeUser(updatedUser)
    });
  } catch (error) {
    console.error("Purchase verify error:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.message || "Satın alma doğrulanamadı."
    });
  }
});

app.get("/api/presets", (req, res) => {
  const presets = Object.entries(MOTION_PRESETS).map(([key, value]) => ({
    key,
    label: value.label,
    prompt: value.prompt,
    negativePrompt: value.negativePrompt
  }));

  res.json({
    success: true,
    presets
  });
});

app.post("/api/generate", authMiddleware, upload.single("image"), async (req, res) => {
  let uploadedFilePath = null;

  try {
    console.log("POST /api/generate hit");
    console.log("Body:", req.body);
    console.log("File:", req.file ? req.file.originalname : "NO_FILE");
    console.log("User:", req.user.id);

    const { motionType, quality, customPrompt } = req.body;
    const user = req.user;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "image dosyası gerekli."
      });
    }

    uploadedFilePath = req.file.path;

    if (!motionType || !MOTION_PRESETS[motionType]) {
      return res.status(400).json({
        success: false,
        error: "Geçerli bir motionType gerekli."
      });
    }

    if (!quality || !["low", "high"].includes(quality)) {
      return res.status(400).json({
        success: false,
        error: "quality 'low' veya 'high' olmalı."
      });
    }

    const creditCost = getCreditCostForQuality(quality);

    if (user.credits < creditCost) {
      return res.status(403).json({
        success: false,
        error: "Yetersiz kredi.",
        credits: user.credits,
        requiredCredits: creditCost
      });
    }

    const finalPrompt = buildPrompt(motionType, customPrompt);
    const negativePrompt = buildNegativePrompt(motionType);

    const insertResult = await runQuery(
      `INSERT INTO generations (
        user_id,
        motion_type,
        quality,
        custom_prompt,
        final_prompt,
        negative_prompt,
        input_image_url,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        user.id,
        motionType,
        quality,
        customPrompt || null,
        finalPrompt,
        negativePrompt,
        null,
        "uploading"
      ]
    );

    const generationId = insertResult.rows[0].id;
    const publicImageUrl = await uploadImageToCloudinary(uploadedFilePath);

    await runQuery(
      `UPDATE generations
       SET input_image_url = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [publicImageUrl, generationId]
    );

    await updateGenerationStatus(generationId, {
      status: "processing"
    });

    const { prediction, maxWaitMs } = await createReplicatePrediction(
      quality,
      publicImageUrl,
      finalPrompt,
      negativePrompt
    );

    await updateGenerationStatus(generationId, {
      status: prediction.status || "processing",
      replicate_prediction_id: prediction.id
    });

    const finalPrediction = await waitForPredictionResult(
      prediction.urls.get,
      maxWaitMs
    );

    if (finalPrediction.status === "succeeded") {
      const videoUrl = normalizeReplicateOutput(finalPrediction.output);

      await updateGenerationStatus(generationId, {
        status: "completed",
        output_video_url: videoUrl,
        replicate_prediction_id: finalPrediction.id
      });

      const updatedUser = await decrementCredit(user.id, creditCost);

      const finalRow = await getQuery(
        `SELECT * FROM generations WHERE id = $1`,
        [generationId]
      );

      return res.json({
        success: true,
        generation: finalRow,
        user: sanitizeUser(updatedUser),
        creditsSpent: creditCost
      });
    }

    const errorMessage =
      finalPrediction.error || "Video üretimi başarısız oldu.";

    await updateGenerationStatus(generationId, {
      status: "failed",
      error_message: errorMessage,
      replicate_prediction_id: finalPrediction.id
    });

    const failedRow = await getQuery(
      `SELECT * FROM generations WHERE id = $1`,
      [generationId]
    );

    return res.status(500).json({
      success: false,
      error: errorMessage,
      generation: failedRow
    });
  } catch (error) {
    console.error("Generate error:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error:
        error.response?.data?.detail ||
        error.response?.data?.error ||
        error.message ||
        "Sunucu hatası oluştu."
    });
  } finally {
    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      try {
        fs.unlinkSync(uploadedFilePath);
      } catch (e) {
        console.error("Dosya silinemedi:", e.message);
      }
    }
  }
});

app.get("/api/generation/:id", authMiddleware, async (req, res) => {
  try {
    const row = await getQuery(
      `SELECT * FROM generations WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (!row) {
      return res.status(404).json({
        success: false,
        error: "Generation bulunamadı."
      });
    }

    return res.json({
      success: true,
      generation: row
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/generations", authMiddleware, async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT * FROM generations WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );

    return res.json({
      success: true,
      generations: rows
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/credits", authMiddleware, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);

    return res.json({
      success: true,
      credits: user.credits,
      is_premium: !!user.is_premium
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/purchases", authMiddleware, async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT id, product_id, transaction_id, original_transaction_id, credits_added, environment, created_at
       FROM purchases
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    return res.json({
      success: true,
      purchases: rows
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

initDatabase()
  .then(async () => {
    try {
      await pool.query("SELECT 1");
      console.log("PostgreSQL connected successfully.");
    } catch (dbError) {
      console.error("PostgreSQL connection failed:", dbError.message);
      process.exit(1);
    }

    console.log("REPLICATE_API_TOKEN exists:", !!process.env.REPLICATE_API_TOKEN);
    console.log("CLOUDINARY_CLOUD_NAME exists:", !!process.env.CLOUDINARY_CLOUD_NAME);
    console.log("CLOUDINARY_API_KEY exists:", !!process.env.CLOUDINARY_API_KEY);
    console.log("CLOUDINARY_API_SECRET exists:", !!process.env.CLOUDINARY_API_SECRET);
    console.log("JWT_SECRET exists:", !!process.env.JWT_SECRET);
    console.log("APPLE_BUNDLE_ID exists:", !!process.env.APPLE_BUNDLE_ID);
    console.log("APPLE_SHARED_SECRET exists:", !!process.env.APPLE_SHARED_SECRET);
    console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });

process.on("SIGINT", async () => {
  console.log("SIGINT alındı, PostgreSQL pool kapatılıyor...");
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM alındı, PostgreSQL pool kapatılıyor...");
  await pool.end();
  process.exit(0);
});
