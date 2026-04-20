const Groq = require("groq-sdk");

/**
 * UTILS: Timeouts & Parsing
 */
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
    ]);
}

function parseJSON(text) {
    try {
        const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("Format Scrambled");
        return JSON.parse(match[0]);
    } catch (e) {
        throw new Error("Response Parsing Error");
    }
}

/**
 * SEMANTIC ENGINE: Enhanced Tagging
 * Maps natural language questions to a compressed state.
 */
function tagQuestion(q) {
    q = q.toLowerCase().replace(/[?!'"]/g, "").trim();
    const map = [
        // Category Primitives
        [/\b(human|person|man|woman|celebrity|individual)\b/, "is-human"],
        [/\b(character|fictional|movie|book|game|anime|cartoon)\b/, "is-fictional"],
        [/\b(animal|creature|beast|insect|fish|bird)\b/, "is-animal"],
        [/\b(object|thing|item|tool|gadget|machine)\b/, "is-object"],
        [/\b(place|location|country|city|area|landmark)\b/, "is-place"],
        [/\b(food|drink|edible|dish|ingredient)\b/, "is-food"],
        
        // Physical Attributes
        [/\b(big|large|huge|giant|massive)\b/, "size-large"],
        [/\b(small|tiny|little|microscopic)\b/, "size-small"],
        [/\b(heavy|weight|ton)\b/, "weight-heavy"],
        [/\b(electronic|electricity|battery|plug|digital)\b/, "is-electronic"],
        [/\b(natural|nature|organic|wild)\b/, "is-natural"],
        [/\b(metal|plastic|wood|glass|fabric)\b/, "material-specific"],
        
        // Abstract/Social
        [/\b(famous|popular|known|celebrity|star)\b/, "is-famous"],
        [/\b(alive|living|exists today)\b/, "is-alive"],
        [/\b(dead|historical|past)\b/, "is-deceased"],
        [/\b(expensive|luxury|costly|wealth)\b/, "is-expensive"],
        [/\b(scary|dangerous|deadly|threat)\b/, "is-dangerous"]
    ];

    for (const [pattern, tag] of map) {
        if (pattern.test(q)) return tag;
    }
    // Fallback: Create a slug from the first 3 keywords
    return q.split(/\s+/).filter(w => w.length > 3).slice(0, 2).join("-") || "unknown-trait";
}

function buildProfile(history) {
    if (!history || history.length < 2) return "STARTING_NEW_GAME";
    return history.reduce((acc, curr, idx) => {
        if (idx % 2 === 0) return acc; // Skip user turns in the loop
        const userAns = history[idx-1]?.text?.toLowerCase().trim();
        const modelQ = history[idx]?.question || "";
        const tag = tagQuestion(modelQ);
        const flag = userAns === "yes" ? "y" : userAns === "no" ? "n" : "u";
        return `${acc} [${tag}:${flag}]`;
    }, "").trim();
}

/**
 * MAIN HANDLER
 */
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keys = (process.env.GROQ_API_KEYS || "").split(',').map(k => k.trim());
    if (!keys.length) return res.status(500).json({ error: "Missing API Keys" });
    
    const groq = new Groq({ apiKey: keys[Math.floor(Math.random() * keys.length)] });
    const { history, userInput, isCorrection, correctThing } = req.body;

    const qCount = history ? Math.floor(history.length / 2) : 0;
    const profile = buildProfile(history || []);

    // SYSTEM ENGINE PROMPT
    const systemPrompt = `You are Avdhez, the Omniscient Jinn. You are a master of Information Theory and Deduction.
    
    CURRENT GAME STATE (Compressed):
    "${profile}"
    
    RULES:
    1. OBJECTIVE: Identify the user's thought in < 20 questions.
    2. STRATEGY: Use "Dichotomous Search". Ask questions that eliminate ~50% of the remaining possibilities.
    3. NO REDUNDANCY: Never ask a question that overlaps with a tag marked :y or :n in the profile.
    4. TYPES: The entity can be Abstract (Freedom), Specific (The Burj Khalifa), or Generic (A Spoon).
    
    OUTPUT FORMAT (Strict JSON):
    {
      "reasoning": "Analyze profile. Rule out X. Hypothesis: Y. Missing info: Z.",
      "hypothesis": "What you currently suspect",
      "question": "Your next Yes/No question",
      "isGuess": false,
      "finalAnswer": "",
      "confidence": 0-100
    }
    
    THRESHOLD: Guess ONLY when confidence > 85% or Q# > 18.
    PHASE: ${qCount < 5 ? "EXPLORE (Broad categories)" : qCount < 12 ? "TRIANGULATE (Specific traits)" : "FINALIZE (Targeting)"}`;

    try {
        const response = await withTimeout(groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "system", content: systemPrompt },
                ...(history ? history.map(h => ({ role: h.role === "model" ? "assistant" : "user", content: h.text })) : []),
                { role: "user", content: userInput || "I have a thought." }
            ],
            temperature: 0.15, // Low temperature for high logical consistency
            response_format: { type: "json_object" }
        }), 12000);

        const result = parseJSON(response.choices[0].message.content);
        
        // Handle Logic Overrides
        if (result.confidence > 85 && !result.isGuess) {
            result.isGuess = true;
            result.finalAnswer = result.hypothesis;
            result.question = `Is it ${result.finalAnswer}?`;
        }

        return res.status(200).json(result);
    } catch (error) {
        return res.status(200).json({ 
            question: "My mind is clouded. Could you repeat that?", 
            isGuess: false, 
            error: error.message 
        });
    }
};