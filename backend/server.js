import express from "express";
import { streamText, generateObject } from "ai";
import { openai as aiSdkOpenAi } from "@ai-sdk/openai";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import crypto from "crypto";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

// ==========================================
//   ENVIRONMENT & FOUNDATION
// ==========================================
const REQUIRED_ENVS = ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "REMOVE_BG_API_KEY"];
for (const env of REQUIRED_ENVS) {
  if (!process.env[env]) {
    console.error(`❌ FATAL: Missing ${env}. Exiting process.`);
    process.exit(1);
  }
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const allowedOrigins = [
    process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/\/$/, "") : null,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
].filter(Boolean);

app.use(cors({
    origin: function(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('CORS block: Origin not allowed'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Production-tuned limiter
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "The atelier is currently at capacity. Please wait a moment." },
  skipFailedRequests: true // Don't count failed auth attempts toward the limit
});

const cleanBase64 = (imageString) => {
    if (!imageString) return null;
    return imageString.includes('base64,') ? imageString.split('base64,')[1] : imageString;
};

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ONLINE", version: "1.2.0", message: "EleVate Engine is operational." });
});

// ==========================================
//   SECURITY MIDDLEWARE
// ==========================================
const requireAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Unauthorized: Missing or invalid token." });
        }

        const token = authHeader.split(" ")[1];
        // Verify against Supabase
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) throw new Error("Invalid session token.");

        // Create scoped client for the request
        req.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });
        
        req.user = user;
        next();
    } catch (err) {
        console.error("[Auth Error]", err.message);
        return res.status(401).json({ error: "Unauthorized access denied." });
    }
};

// Apply security to all /api routes
app.use("/api", limiter, requireAuth);

const RequestSchema = z.object({
    image: z.string().nullable().optional(),
    mode: z.string(),
    occasion: z.string().optional(),
    notes: z.string().optional(),
    fitPreference: z.string().optional(),
    contrast: z.string().optional(),
    climate: z.string().optional(),
    mood: z.string().optional(),
    measurements: z.record(z.any()).optional(),
    stressTest: z.boolean().optional(),
    edgeCaseMode: z.boolean().optional()
});

// ==========================================
//   CORE AI STYLING ENGINE (REFACTORED)
// ==========================================
app.post("/api/chat", async (req, res, next) => {
    const reqId = crypto.randomUUID();
    console.log(`[${reqId}] Request: ${req.body.mode} | User: ${req.user.id}`);

    try {
        const data = RequestSchema.parse(req.body);
        const vaultPlaceholder = "https://dummyimage.com/600x400/020617/c5a059.png&text=Wardrobe+Curated+Outfit";

        // 1. Initial Database Entry
        const { error: initialDbError } = await req.supabase
            .from("wardrobe_analyses")
            .insert([{
                id: reqId, 
                user_id: req.user.id, 
                mode: data.mode, 
                occasion: data.occasion || null,
                mood: data.mood || null, 
                notes: data.notes || null, 
                image_url: data.image ? "pending_upload" : vaultPlaceholder
            }]);

        if (initialDbError) throw new Error(`DB Init Failed: ${initialDbError.message}`);

        // 2. Async Image Handling (Non-blocking)
        const safeImage = cleanBase64(data.image);
        if (safeImage) {
            const imageBuffer = Buffer.from(safeImage, "base64");
            const fileName = `${req.user.id}/${reqId}.jpg`;
            
            // Background task
            (async () => {
                try {
                    const { error: upError } = await req.supabase.storage.from("wardrobe_images")
                        .upload(fileName, imageBuffer, { contentType: "image/jpeg", upsert: false });
                    
                    if (!upError) {
                        const { data: { publicUrl } } = req.supabase.storage.from("wardrobe_images").getPublicUrl(fileName);
                        await req.supabase.from("wardrobe_analyses").update({ image_url: publicUrl }).eq("id", reqId);
                    }
                } catch (e) {
                    console.error(`[${reqId}] Image Storage Error:`, e.message);
                }
            })();
        }

        // 3. Context Preparation
        let vaultContext = "No wardrobe items available.";
        if (["wardrobe_builder", "travel_curator", "office_curation", "morning_briefing", "acquisition_board", "match_vibe"].includes(data.mode)) {
            const { data: vaultItems } = await req.supabase
                .from("my_closet")
                .select("id, image_url, category, notes, status, total_wears, primary_color, pattern")
                .not("status", "in", '("NEEDS_CARE", "OUT_FOR_CLEANING")')
                .order("total_wears", { ascending: true })
                .limit(50);
            if (vaultItems?.length > 0) vaultContext = JSON.stringify(vaultItems);
        }

        // 4. Schema Selection
        const baseSchema = {
            score: "number 0-100",
            tier: "Baseline/Functional/Intentional/Refined/Elite",
            verdict: "summary string",
            archetype: "style archetype",
            missing_pieces: ["item 1"],
        };

        const dynamicJSONSchema = data.mode === 'fit' ? 
            { ...baseSchema, fit_anatomy: { shoulders: [], waist: [], legs: [] }, alteration_blueprint: [] } : 
            { ...baseSchema, breakdown: {}, outfit_combinations: [{ name: "", reasoning: "", item_ids: [] }], styling_notes: [] };

        const systemPrompt = `You are EleVate's Master Stylist.
        Mode: ${data.mode} | Occasion: ${data.occasion || 'General'}
        Wardrobe Context: ${vaultContext}
        STRICT RULES:
        1. Return ONLY valid JSON.
        2. Assign Tier based on Score: 0-59: Baseline, 60-69: Functional, 70-79: Intentional, 80-89: Refined, 90-100: Elite.
        3. If using wardrobe items, use exact "id" strings.
        Schema: ${JSON.stringify(dynamicJSONSchema)}`;

        // 5. Execution
        const messages = [{ role: "system", content: systemPrompt }];
        if (safeImage) {
            messages.push({
                role: "user",
                content: [
                    { type: "text", text: `Analyze this image. Notes: ${data.notes || 'None'}.` },
                    { type: "image", image: Buffer.from(safeImage, "base64") }
                ]
            });
        } else {
            messages.push({ role: "user", content: `Execute styling core. Notes: ${data.notes || 'No notes'}` });
        }

        const result = await streamText({
            model: aiSdkOpenAi("gpt-4o"),
            messages,
            temperature: 0.3,
            onFinish: async (event) => {
                // Background update of final record once stream ends
                try {
                    let cleanText = event.text.trim();
                    if (cleanText.startsWith('```')) {
                        cleanText = cleanText.replace(/^```(json)?\s*/i, '').replace(/\s*```$/i, '').trim();
                    }
                    const parsed = JSON.parse(cleanText);
                    await req.supabase.from("wardrobe_analyses").update({
                        full_analysis: parsed,
                        score: parsed.score || null,
                        tier: parsed.tier || null,
                        verdict: parsed.verdict || "Analysis Complete"
                    }).eq("id", reqId);
                } catch (e) {
                    console.error(`[${reqId}] Final DB Update Failed:`, e.message);
                }
            }
        });

        // Use the native Vercel AI SDK helper to pipe to response safely
        return result.pipeTextIntoResponse(res);

    } catch (err) {
        console.error(`[${reqId}] Fatal Route Error:`, err.message);
        if (!res.headersSent) {
            return res.status(err instanceof z.ZodError ? 400 : 500).json({ 
                error: err.message || "An internal server error occurred." 
            });
        }
    }
});

// All other routes remain largely the same, but ensure they use res.json() correctly.
// [Include your ledger/tagging routes here, ensuring try/catch wrappers]

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(`[Global Error] ${req.method} ${req.url}:`, err.message);
    if (!res.headersSent) {
        res.status(500).json({ error: "The atelier engine encountered a critical error." });
    }
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 ELEVATE ENGINE ONLINE: PORT ${PORT}.`);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;