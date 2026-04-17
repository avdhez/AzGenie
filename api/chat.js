const { GoogleGenerativeAI } = require("@google/generative-ai");

module.exports = async function handler(req, res) {
    // 1. Check API Key
    if (!process.env.GEMINI_API_KEY) {
        console.error("CRITICAL ERROR: GEMINI_API_KEY is missing.");
        return res.status(500).json({ 
            error: "API Key missing!",
            question: "SYSTEM ERROR: Missing API Key.", 
            isGuess: false 
        });
    }

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // THE FINAL FIX: Using the explicit, universally available 8B model
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash-8b",
            systemInstruction: `
                You are 'The Mystic Node', an all-knowing entity. You can guess any character, object, animal, or concept in existence.
                Rules:
                1. Ask ONE YES/NO question at a time.
                2. Respond ONLY in strict JSON format: {"question": "Your question here", "isGuess": false, "finalAnswer": ""}
                3. If you are 90% sure, set 'isGuess' to true, and put your guess in 'finalAnswer'.
                4. Do not include markdown tags.
            `
        });
        
        const { history, userInput, isCorrection, correctThing } = req.body;
        const safeHistory = history ? history.map(h => ({ role: h.role, parts: [{ text: h.text }] })) : [];

        // If the user is teaching the bot after a wrong guess
        if (isCorrection) {
            const learningPrompt = `I was thinking of "${correctThing}". Review our history: ${JSON.stringify(safeHistory)}. Learn from this mistake. Reply with strict JSON: {"question": "Got it! I will remember that. Let's play again!"}`;
            await model.generateContent(learningPrompt);
            return res.json({ reset: true });
        }

        const chat = model.startChat({ history: safeHistory });
        
        const result = await chat.sendMessage(userInput || "Let's start!");
        let responseText = result.response.text();
        
        // Clean the response from potential markdown formatting
        responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        res.status(200).json(JSON.parse(responseText));

    } catch (error) {
        console.error("API Crash Details:", error);
        res.status(200).json({ 
            question: `SERVER ERROR: ${error.message}`, 
            isGuess: false 
        });
    }
};