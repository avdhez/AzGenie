const { GoogleGenerativeAI } = require("@google/generative-ai");

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.GEMINI_API_KEYS;
    if (!keysString) {
        return res.status(200).json({ question: "SYSTEM ERROR: Missing GEMINI_API_KEYS.", isGuess: false });
    }

    // 1. Create an array of keys and shuffle them randomly
    let keyArray = keysString.split(',').map(k => k.trim());
    keyArray = keyArray.sort(() => 0.5 - Math.random());

    const { history, userInput, isCorrection, correctThing } = req.body;
    const safeHistory = history ? history.map(h => ({ role: h.role, parts: [{ text: h.text }] })) : [];

    // 2. THE SILENT RETRY LOOP
    // The server will try every single key in your list until one works.
    for (let i = 0; i < keyArray.length; i++) {
        const currentKey = keyArray[i];

        try {
            const genAI = new GoogleGenerativeAI(currentKey);
            
            // Downgraded to 1.5-flash to get 15 requests per minute instead of 5
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.0-flash",
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
            
            // If it succeeds, immediately return the data to the user and EXIT the loop
            return res.status(200).json(JSON.parse(cleanJSON));

        } catch (error) {
            // If it hits a Rate Limit, do NOT tell the user. 
            // The loop will simply 'continue' and try the next key instantly.
            if (error.status === 429 || error.message.includes("429") || error.message.includes("quota")) {
                console.log(`Key ${i+1} hit rate limit. Switching seamlessly...`);
                continue; 
            }

            // If the AI just scrambled the JSON, we ask the user to click again
            if (error.message.includes("Format Scrambled") || error.message.includes("Unexpected token")) {
                return res.status(200).json({ 
                    question: "The magic got scrambled. Can you click your answer again?", 
                    isGuess: false,
                    isRateLimit: true
                });
            }

            // For any other weird server errors, stop and report
            return res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
        }
    }

    // 3. THE ABSOLUTE BACKUP
    // If the code reaches this line, it means EVERY SINGLE KEY failed at the exact same time.
    return res.status(200).json({ 
        question: "All my neural pathways are exhausted! Please wait 15 seconds and try again.", 
        isGuess: false, 
        isRateLimit: true 
    });
};