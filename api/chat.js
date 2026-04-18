const { GoogleGenerativeAI } = require("@google/generative-ai");

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.GEMINI_API_KEYS;
    if (!keysString) {
        return res.status(200).json({ question: "SYSTEM ERROR: Missing GEMINI_API_KEYS.", isGuess: false });
    }

    // 1. Create an array of keys and shuffle them randomly
    let keyArray = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);
    keyArray = keyArray.sort(() => 0.5 - Math.random());

    const { history, userInput, isCorrection, correctThing } = req.body;
    const safeHistory = history ? history.map(h => ({ role: h.role, parts: [{ text: h.text }] })) : [];

    // 2. THE SILENT RETRY LOOP
    for (let i = 0; i < keyArray.length; i++) {
        const currentKey = keyArray[i];

        try {
            const genAI = new GoogleGenerativeAI(currentKey);

            // gemini-2.0-flash-lite: free tier, generous RPM, perfect for this use case
            const model = genAI.getGenerativeModel({
                model: "gemini-2.0-flash-lite",
                systemInstruction: `
                    You are 'The Mystic Node', an Akinator-style mind-reading bot. You must figure out what the user is thinking of.
                    CRITICAL RULES:
                    1. You MUST phrase your question so it can ONLY be answered with "Yes", "No", "Maybe", or "Don't know".
                    2. NEVER ask "A or B" questions. (e.g., NEVER ask "Is it real or fictional?". Instead ask "Is it a real person?").
                    3. DO NOT GUESS IMMEDIATELY. Ask strategic, broad questions first to gather clues.
                    4. Respond ONLY in strict JSON format: {"question": "Your exact yes/no question", "isGuess": false, "finalAnswer": ""}
                    5. ONLY set "isGuess" to true if you are highly confident based on clues. If true, put your guess in "finalAnswer".
                    6. Absolutely NO conversational filler. ONLY output the JSON object.
                `
            });

            if (isCorrection) {
                const learningPrompt = `I was thinking of "${correctThing}". Review our history: ${JSON.stringify(safeHistory)}. Learn from your mistake. Reply with strict JSON: {"question": "Got it! I will remember that. Let's play again!", "isGuess": false, "finalAnswer": ""}`;
                await model.generateContent(learningPrompt);
                return res.status(200).json({ reset: true });
            }

            const chat = model.startChat({ history: safeHistory });
            const result = await chat.sendMessage(userInput || "Let's start!");
            let responseText = result.response.text();

            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("Format Scrambled");

            const cleanJSON = jsonMatch[0].trim();

            // Success! Send data to frontend and EXIT the loop.
            return res.status(200).json(JSON.parse(cleanJSON));

        } catch (error) {
            const msg = (error.message || "").toLowerCase();
            const status = error.status || error.code;

            console.log(`Key ${i + 1}/${keyArray.length} failed — status: ${status}, message: ${error.message}`);

            // Rate limited — try the next key
            if (status === 429 || msg.includes("429") || msg.includes("quota") || msg.includes("rate")) {
                continue;
            }

            // Dead / invalid key — skip it
            if (msg.includes("api_key_invalid") || msg.includes("invalid api key") || msg.includes("expired")) {
                continue;
            }

            // Model not found or not available on this key's tier — skip and try next key
            if (status === 404 || msg.includes("not found") || msg.includes("not supported") || msg.includes("permission")) {
                continue;
            }

            // AI returned scrambled JSON — ask user to retry (no key switch needed)
            if (error.message.includes("Format Scrambled") || msg.includes("unexpected token")) {
                return res.status(200).json({
                    question: "The magic got scrambled. Can you click your answer again?",
                    isGuess: false,
                    isRateLimit: true
                });
            }

            // Unknown hard error — stop and report it
            return res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
        }
    }

    // 3. All keys exhausted
    return res.status(200).json({
        question: `All ${keyArray.length} neural pathways are exhausted or disconnected! Please wait a moment and try again.`,
        isGuess: false,
        isRateLimit: true
    });
};
