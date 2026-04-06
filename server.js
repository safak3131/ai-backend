require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const sqlite3 = require("sqlite3").verbose();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, "uploads");
const DB_PATH = path.join(__dirname, "database.sqlite");

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, UPLOADS_DIR);
    },
    filename: function(req, file, cb) {
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

const db = new sqlite3.Database(DB_PATH);

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, function(err, row) {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function allQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, function(err, rows) {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function initDatabase() {
    await runQuery(`
    CREATE TABLE IF NOT EXISTS generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

    await runQuery(`
    CREATE TABLE IF NOT EXISTS user_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      limit_date TEXT NOT NULL,
      generation_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, limit_date)
    )
  `);
}

const MOTION_PRESETS = {
    cinematic_pan: {
        label: "Cinematic Pan",
        prompt: "Camera slowly pans from left to right around the architectural building, realistic lighting, subtle environmental movement, cinematic quality, 4K",
        negativePrompt: "different building, redesigned house, altered facade, warped architecture, deformed geometry, extra windows, missing walls, unrealistic motion, shaky camera, low quality, blurry, flicker"
    },
    slow_zoom_in: {
        label: "Slow Zoom In",
        prompt: "Slow cinematic zoom toward the architectural building, preserve original structure exactly, subtle environmental motion, realistic lighting, stable composition, high detail",
        negativePrompt: "different building, redesigned house, altered facade, warped architecture, structure changes, extra elements, shaky motion, blur, flicker, low quality"
    },
    orbit_camera: {
        label: "Orbit Camera",
        prompt: "Camera smoothly orbits around the architectural building, preserve original design, stable structure, cinematic motion, natural lighting, subtle movement in environment",
        negativePrompt: "different building, redesigned house, altered facade, warped geometry, unstable structure, camera shake, blur, flicker, low quality"
    },
    drone_flyover: {
        label: "Drone Flyover",
        prompt: "Smooth drone flyover around the architectural building, preserve the original building exactly, cinematic aerial motion, realistic environment, stable structure, professional visualization quality",
        negativePrompt: "different building, redesigned house, altered facade, warped geometry, unstable building, weird camera path, shaky motion, blur, flicker, low quality"
    }
};

function getTodayDateString() {
    return new Date().toISOString().slice(0, 10);
}

function getUserDailyLimit(isPremium) {
    return isPremium ?
        Number(process.env.PREMIUM_DAILY_LIMIT || 10) :
        Number(process.env.FREE_DAILY_LIMIT || 2);
}

async function getUserLimitRow(userId, dateStr) {
    let row = await getQuery(
        `SELECT * FROM user_limits WHERE user_id = ? AND limit_date = ?`, [userId, dateStr]
    );

    if (!row) {
        await runQuery(
            `INSERT INTO user_limits (user_id, limit_date, generation_count) VALUES (?, ?, 0)`, [userId, dateStr]
        );
        row = await getQuery(
            `SELECT * FROM user_limits WHERE user_id = ? AND limit_date = ?`, [userId, dateStr]
        );
    }

    return row;
}

async function checkUserCanGenerate(userId, isPremium) {
    const today = getTodayDateString();
    const row = await getUserLimitRow(userId, today);
    const allowedLimit = getUserDailyLimit(isPremium);

    return {
        canGenerate: row.generation_count < allowedLimit,
        currentCount: row.generation_count,
        allowedLimit
    };
}

async function incrementUserDailyCount(userId) {
    const today = getTodayDateString();
    await getUserLimitRow(userId, today);

    await runQuery(
        `UPDATE user_limits
     SET generation_count = generation_count + 1
     WHERE user_id = ? AND limit_date = ?`, [userId, today]
    );
}

async function uploadImageToImgBB(filePath) {
    const imageBase64 = fs.readFileSync(filePath, { encoding: "base64" });

    const form = new FormData();
    form.append("key", process.env.IMGBB_API_KEY);
    form.append("image", imageBase64);

    const response = await axios.post("https://api.imgbb.com/1/upload", form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity
    });

    if (!response.data || !response.data.success) {
        throw new Error("ImgBB upload failed.");
    }

    return response.data.data.url;
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
        `https://api.replicate.com/v1/models/${modelConfig.modelSlug}/predictions`, { input }, {
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
     SET status = ?,
         output_video_url = ?,
         error_message = ?,
         replicate_prediction_id = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`, [
            data.status || null,
            data.output_video_url || null,
            data.error_message || null,
            data.replicate_prediction_id || null,
            id
        ]
    );
}

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "ArchVideo backend çalışıyor."
    });
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

app.post("/api/generate", upload.single("image"), async(req, res) => {
    let uploadedFilePath = null;

    try {
        const { motionType, user_id, is_premium, quality, customPrompt } = req.body;

        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: "image dosyası gerekli."
            });
        }

        uploadedFilePath = req.file.path;

        if (!user_id) {
            return res.status(400).json({
                success: false,
                error: "user_id gerekli."
            });
        }

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

        const isPremiumUser =
            is_premium === true ||
            is_premium === "true" ||
            is_premium === 1 ||
            is_premium === "1";

        const limitInfo = await checkUserCanGenerate(user_id, isPremiumUser);

        if (!limitInfo.canGenerate) {
            return res.status(429).json({
                success: false,
                error: "Günlük üretim limitine ulaşıldı.",
                dailyUsed: limitInfo.currentCount,
                dailyLimit: limitInfo.allowedLimit
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                user_id,
                motionType,
                quality,
                customPrompt || null,
                finalPrompt,
                negativePrompt,
                null,
                "uploading"
            ]
        );

        const generationId = insertResult.lastID;

        const publicImageUrl = await uploadImageToImgBB(uploadedFilePath);

        await runQuery(
            `UPDATE generations
       SET input_image_url = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`, [publicImageUrl, generationId]
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

        const finalPrediction = await waitForPredictionResult(prediction.urls.get, maxWaitMs);

        if (finalPrediction.status === "succeeded") {
            const videoUrl = normalizeReplicateOutput(finalPrediction.output);

            await updateGenerationStatus(generationId, {
                status: "completed",
                output_video_url: videoUrl,
                replicate_prediction_id: finalPrediction.id
            });

            await incrementUserDailyCount(user_id);

            const finalRow = await getQuery(
                `SELECT * FROM generations WHERE id = ?`, [generationId]
            );

            return res.json({
                success: true,
                generation: finalRow,
                dailyUsed: limitInfo.currentCount + 1,
                dailyLimit: limitInfo.allowedLimit
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
            `SELECT * FROM generations WHERE id = ?`, [generationId]
        );

        return res.status(500).json({
            success: false,
            error: errorMessage,
            generation: failedRow
        });
    } catch (error) {
        console.error("Generate error:", error.response ? .data || error.message);

        return res.status(500).json({
            success: false,
            error: error.response ? .data ? .detail ||
                error.response ? .data ? .error ||
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

app.get("/api/generation/:id", async(req, res) => {
    try {
        const row = await getQuery(
            `SELECT * FROM generations WHERE id = ?`, [req.params.id]
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

app.get("/api/generations/:userId", async(req, res) => {
    try {
        const rows = await allQuery(
            `SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC`, [req.params.userId]
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

app.get("/api/usage/:userId", async(req, res) => {
    try {
        const isPremium =
            req.query.is_premium === "true" ||
            req.query.is_premium === "1";

        const today = getTodayDateString();
        const row = await getUserLimitRow(req.params.userId, today);
        const dailyLimit = getUserDailyLimit(isPremium);

        return res.json({
            success: true,
            user_id: req.params.userId,
            date: today,
            used: row.generation_count,
            limit: dailyLimit,
            remaining: Math.max(0, dailyLimit - row.generation_count)
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

initDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch((err) => {
        console.error("DB init failed:", err);
        process.exit(1);
    });