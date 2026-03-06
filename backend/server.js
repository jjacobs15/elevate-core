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

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, 
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "The atelier is currently at capacity. Please wait a moment." }
});

const cleanBase64 = (imageString) => {
    if (!imageString) return null;
    return imageString.includes('base64,') ? imageString.split('base64,')[1] : imageString;
};

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ONLINE", message: "EleVate Engine is operational." });
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
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) throw new Error("Invalid session token.");

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
//   STUDIO POLISH 
// ==========================================
app.post("/api/remove-bg", async (req, res, next) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

    const base64Data = cleanBase64(image);
    
    try {
        const bgRes = await fetch('https://api.remove.bg/v1.0/removebg', {
          method: 'POST',
          headers: { 
            'X-Api-Key': process.env.REMOVE_BG_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json' 
          },
          body: JSON.stringify({ image_file_b64: base64Data, size: 'preview' })
        });

        if (!bgRes.ok) throw new Error("RemoveBG limit reached or request failed.");
        const data = await bgRes.json();
        return res.json({ image: `data:image/png;base64,${data.data.result_b64}` });
    } catch (bgError) {
        console.warn("[RemoveBG Warning] Falling back to original image:", bgError.message);
        return res.json({ image: `data:image/jpeg;base64,${base64Data}` });
    }
  } catch (error) {
    next(error);
  }
});

// ==========================================
//   AUTO-TAGGING 
// ==========================================
app.post("/api/wardrobe/auto-tag", async (req, res, next) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: "Image required for tagging" });

    const safeImage = cleanBase64(image);
    const imageBuffer = Buffer.from(safeImage, "base64");

    const TaggingSchema = z.object({
      primary_color: z.string().describe("The dominant color"),
      secondary_color: z.string().nullable().describe("The accent color, or null"),
      pattern: z.string(),
      seasonality: z.enum(["Summer", "Winter", "All-Season", "Fall/Spring"]),
      fabric_weight_category: z.enum(["Heavyweight", "Midweight", "Lightweight", "Tropical"]),
      drape_index: z.number().min(1).max(10).describe("1 = Stiff/Structured, 10 = Flowing/Unstructured"),
      estimated_lifespan_wears: z.number().describe("Estimated wears before needing replacement")
    });

    try {
        const { object } = await generateObject({
          model: aiSdkOpenAi("gpt-4o-mini"),
          schema: TaggingSchema,
          messages: [
            { 
              role: "user", 
              content: [
                { type: "text", text: "Analyze this garment. Identify its visual properties. STRICT DIRECTIVE: IGNORE ANY HUMAN IN THE PHOTO." },
                { type: "image", image: imageBuffer } 
              ] 
            }
          ],
          temperature: 0.1,
        });
        res.json({ success: true, tags: object });
    } catch (aiError) {
        console.warn("[Auto-Tag Warning] Returning default tags:", aiError.message);
        res.json({ success: true, tags: {
            primary_color: "Unknown", secondary_color: null, pattern: "Solid",
            seasonality: "All-Season", fabric_weight_category: "Midweight",
            drape_index: 5, estimated_lifespan_wears: 100
        }});
    }
  } catch (error) {
    next(error);
  }
});

// ==========================================
//   CARE TAG ANALYSIS 
// ==========================================
app.post("/api/ledger/analyze-care-tag", async (req, res, next) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: "Image required" });

    const safeImage = cleanBase64(image);
    const imageBuffer = Buffer.from(safeImage, "base64");

    const CareTagSchema = z.object({
      careProfile: z.object({
        instructions: z.array(z.string()).describe("List of care instructions found on tag"),
        is_machine_washable: z.boolean().describe("True if machine washing is allowed")
      })
    });

    try {
        const { object } = await generateObject({
          model: aiSdkOpenAi("gpt-4o-mini"),
          schema: CareTagSchema,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Read this clothing care tag. Extract washing and drying instructions." },
                { type: "image", image: imageBuffer }
              ]
            }
          ],
          temperature: 0.1,
        });
        res.json(object);
    } catch (aiError) {
        console.warn("[Care Tag Warning] Returning defaults:", aiError.message);
        res.json({ careProfile: { instructions: ["Read physical tag"], is_machine_washable: true } });
    }
  } catch (error) {
    next(error);
  }
});

// ==========================================
//   GHOST SIMULATION (ANCHOR PIECE CURATOR)
// ==========================================
app.post("/api/designer/ghost-simulation", async (req, res, next) => {
  try {
    const { ghostItemImageBase64, ghostItemDescription } = req.body;
    if (!ghostItemImageBase64) return res.status(400).json({ error: "Image required" });

    const safeImage = cleanBase64(ghostItemImageBase64);
    const imageBuffer = Buffer.from(safeImage, "base64");

    let vaultContext = "No existing wardrobe items available.";
    const { data: vaultItems } = await req.supabase
        .from("my_closet")
        .select("category, notes, primary_color, pattern")
        .not("status", "in", '("NEEDS_CARE", "OUT_FOR_CLEANING")')
        .limit(50);
        
    if (vaultItems && vaultItems.length > 0) vaultContext = JSON.stringify(vaultItems);

    const GhostSchema = z.object({
      simulation: z.object({
        versatility_index: z.number().describe("Score 0-100 on how well this piece integrates."),
        aesthetic_impact: z.string().describe("A 2-sentence breakdown of how this piece elevates the wardrobe."),
        sample_outfits: z.array(z.object({
          outfit_name: z.string(),
          reasoning: z.string(),
          existing_categories_used: z.array(z.string())
        })),
        missing_pieces: z.array(z.string()).describe("Items the user should buy next to complete the look.")
      })
    });

    const { object } = await generateObject({
      model: aiSdkOpenAi("gpt-4o"),
      schema: GhostSchema,
      messages: [
        { role: "system", content: `You are EleVate's Master Stylist. Evaluate this new anchor piece (${ghostItemDescription || "Garment"}). Available Wardrobe: ${vaultContext}` },
        { role: "user", content: [
            { type: "text", text: "Simulate outfits using this anchor piece and the available wardrobe." }, 
            { type: "image", image: imageBuffer }
          ] 
        }
      ],
      temperature: 0.3,
    });

    res.json(object);
  } catch (error) {
    next(error);
  }
});

// ==========================================
//   CHRONOS AESTHETIC HEATMAP (RESTORED!)
// ==========================================
app.get("/api/analytics/chronos", async (req, res, next) => {
  try {
    const { data: dossiers, error } = await req.supabase
      .from("wardrobe_analyses")
      .select("score, verdict, created_at")
      .not("score", "is", null)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw new Error(error.message);
    
    if (!dossiers || dossiers.length < 2) {
      return res.json({ message: "Not enough data yet. Run at least 2 Stylist evaluations to unlock Chronos." });
    }

    const ChronosSchema = z.object({
      chronos: z.object({
        trajectory: z.enum(["Improving", "Stagnant", "Declining"]),
        average_score_shift: z.string().describe("e.g., '+5 points' or '-2 points'"),
        aesthetic_drift: z.string().describe("A 2-sentence analysis of how their style is evolving based on recent verdicts."),
        course_correction: z.string().describe("1 actionable piece of advice to improve their next look.")
      })
    });

    const { object } = await generateObject({
      model: aiSdkOpenAi("gpt-4o"),
      schema: ChronosSchema,
      messages: [
        {
          role: "system",
          content: `You are EleVate's Chronos AI. Analyze this user's recent outfit scores and verdicts to determine their style evolution: ${JSON.stringify(dossiers)}`
        },
        {
          role: "user",
          content: "Generate the Chronos Aesthetic Heatmap analysis based on my history."
        }
      ],
      temperature: 0.3,
    });

    res.json(object);
  } catch (error) {
    next(error);
  }
});

// ==========================================
//   THE MAINTENANCE LEDGER (DIGITAL VALET)
// ==========================================
const WEAR_THRESHOLDS = { "Suit": 4, "Blazer": 5, "Denim": 10, "Knitwear": 4, "Dress Shirt": 2, "T-Shirt": 1, "Default": 3 };

app.post("/api/ledger/increment", async (req, res, next) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: "itemId is required" });

    const { data: item, error: fetchError } = await req.supabase
      .from("my_closet")
      .select("category, wear_count, total_wears, wear_threshold, price") 
      .eq("id", itemId)
      .single();

    if (fetchError || !item) return res.status(404).json({ error: "Item not found or access denied." });

    const limit = item.wear_threshold || WEAR_THRESHOLDS[item.category] || WEAR_THRESHOLDS["Default"];
    const newWearCount = (item.wear_count || 0) + 1;
    const newTotalWears = (item.total_wears || 0) + 1;
    const newStatus = newWearCount >= limit ? "NEEDS_CARE" : "WORN";
    const currentPrice = item.price || 0;
    const newCpw = currentPrice > 0 ? parseFloat((currentPrice / newTotalWears).toFixed(2)) : null;

    const { data: updatedItem, error: updateError } = await req.supabase
      .from("my_closet")
      .update({ wear_count: newWearCount, total_wears: newTotalWears, status: newStatus, cost_per_wear: newCpw })
      .eq("id", itemId)
      .select()
      .single();

    if (updateError) throw new Error(updateError.message);
    res.json({ success: true, item: updatedItem });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ledger/nightstand-log", async (req, res, next) => {
  try {
    const { itemIds } = req.body;
    for (const id of itemIds) {
        const { data: item } = await req.supabase.from("my_closet").select("*").eq("id", id).single();
        if (!item) continue;
        const limit = item.wear_threshold || WEAR_THRESHOLDS[item.category] || WEAR_THRESHOLDS["Default"];
        const newWearCount = (item.wear_count || 0) + 1;
        const newStatus = newWearCount >= limit ? "NEEDS_CARE" : "WORN";
        await req.supabase.from("my_closet").update({ wear_count: newWearCount, total_wears: (item.total_wears || 0) + 1, status: newStatus }).eq("id", id);
    }
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.post("/api/ledger/reset", async (req, res, next) => {
  try {
    const { itemIds } = req.body;
    await req.supabase.from("my_closet").update({ wear_count: 0, status: 'CLEAN' }).in('id', itemIds);
    res.json({ success: true });
  } catch (error) { next(error); }
});

// ==========================================
//   CORE AI STYLING ENGINE (CHAT)
// ==========================================
app.post("/api/chat", async (req, res, next) => {
  const reqId = crypto.randomUUID();
  console.log(`[${reqId}] Incoming ${req.body.mode} request from User: ${req.user.id}`);

  try {
    const data = RequestSchema.parse(req.body);
    const vaultPlaceholder = "https://dummyimage.com/600x400/020617/c5a059.png&text=Wardrobe+Curated+Outfit";

    const { error: initialDbError } = await req.supabase
      .from("wardrobe_analyses")
      .insert([{
        id: reqId, user_id: req.user.id, mode: data.mode, occasion: data.occasion || null,
        mood: data.mood || null, notes: data.notes || null, image_url: data.image ? "pending_upload" : vaultPlaceholder
      }]);

    if (initialDbError) throw new Error(`Failed to init record: ${initialDbError.message}`);

    const safeImage = cleanBase64(data.image);

    if (safeImage) {
      const imageBuffer = Buffer.from(safeImage, "base64");
      const fileName = `${req.user.id}/${reqId}.jpg`; 
      req.supabase.storage.from("wardrobe_images").upload(fileName, imageBuffer, { contentType: "image/jpeg", upsert: false })
        .then(async ({ error: uploadError }) => {
          if (!uploadError) {
             const { data: { publicUrl } } = req.supabase.storage.from("wardrobe_images").getPublicUrl(fileName);
             await req.supabase.from("wardrobe_analyses").update({ image_url: publicUrl }).eq("id", reqId);
          }
        });
    }

    let vaultContext = "No wardrobe items available.";
    if (["wardrobe_builder", "travel_curator", "office_curation", "morning_briefing", "acquisition_board"].includes(data.mode)) {
        const { data: vaultItems } = await req.supabase
            .from("my_closet").select("id, image_url, category, notes, status, total_wears, primary_color, pattern")
            .not("status", "in", '("NEEDS_CARE", "OUT_FOR_CLEANING")').order("total_wears", { ascending: true }).limit(50);
        if (vaultItems && vaultItems.length > 0) vaultContext = JSON.stringify(vaultItems);
    } 

    const systemPrompt = `You are EleVate's Master Stylist.
    Mode: ${data.mode}
    Occasion: ${data.occasion || 'General'}
    Client Preferences: ${data.fitPreference || 'Tailored'}, Contrast: ${data.contrast || 'Medium'}
    Climate Context: ${data.climate || 'Unknown'}
    Measurements: ${JSON.stringify(data.measurements || {})}
    Available Wardrobe (JSON): ${vaultContext}
    
    CRITICAL DIRECTIVES:
    1. Ignore any human features in the photo. Focus entirely on the clothing. 
    2. YOU MUST CALCULATE REAL SCORES based on the garments. DO NOT USE PLACEHOLDER NUMBERS.
    3. TIER CLASSIFICATION SYSTEM: You must strictly assign the "tier" based on your final calculated "score" using this exact scale:
       - 0 to 59 = "Baseline"
       - 60 to 69 = "Functional"
       - 70 to 79 = "Intentional"
       - 80 to 89 = "Refined"
       - 90 to 100 = "Elite"
    
    YOUR OUTPUT MUST BE STRICTLY VALID JSON. DO NOT WRAP IN MARKDOWN. Example structure:
    {
      "score": 75,
      "tier": "Intentional",
      "verdict": "A brief summary of the look.",
      "archetype": "The Executive",
      "breakdown": { "color": 15, "occasion": 15, "fit": 15, "cohesion": 15, "presence": 15 },
      "styling_notes": ["Note 1", "Note 2"],
      "outfit_combinations": [
        { "name": "Look Name", "reasoning": "Why this works", "item_urls": ["url1"] }
      ],
      "what_works": ["Strength 1"],
      "recommendations": ["Upgrade 1"],
      "missing_pieces": ["Gap 1"],
      "acquisition_list": [
        { "item": "Navy Blazer", "priority": "High", "reasoning": "Missing anchor piece" }
      ]
    }`;

    const messages = [{ role: "system", content: systemPrompt }];
    
    if (safeImage) {
        const aiBuffer = Buffer.from(safeImage, "base64");
        messages.push({
            role: "user",
            content: [
                { type: "text", text: `Analyze this image. Notes: ${data.notes || 'None'}.` },
                { type: "image", image: aiBuffer } 
            ]
        });
    } else {
        messages.push({ role: "user", content: `Please execute styling core. Notes: ${data.notes || 'No notes'}` });
    }

    const result = await streamText({ model: aiSdkOpenAi("gpt-4o"), messages: messages, temperature: 0.3 });

    let fullResponse = "";
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');

    for await (const chunk of result.textStream) {
        fullResponse += chunk;
        res.write(chunk);
    }
    res.end();

    try {
        let cleanJson = fullResponse.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        const parsedJson = JSON.parse(cleanJson);
        await req.supabase.from("wardrobe_analyses").update({ 
            full_analysis: parsedJson, score: parsedJson.score || null, tier: parsedJson.tier || null, verdict: parsedJson.verdict || "Analysis Complete"
        }).eq("id", reqId);
    } catch (e) {
        console.error(`[${reqId}] Failed to save final JSON state:`, e.message);
    }

  } catch (err) { next(err); }
});

app.use((err, req, res, next) => {
  console.error(`[Global Error] ${req.method} ${req.url}:`, err.message);
  if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid request payload" });
  res.status(500).json({ error: "An internal server error occurred." });
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, "0.0.0.0", () => { 
    console.log(`🚀 ELEVATE ENGINE ONLINE: PORT ${PORT}.`); 
});
server.keepAliveTimeout = 120000; 
server.headersTimeout = 125000;