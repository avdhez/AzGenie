const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// We changed 'export default' to 'module.exports' here!
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { history, userInput, isCorrection, correctThing } = req.body;
    
    // Safety check just in case history is empty
    const safeHistory = history ? history.map(h => ({ role: h.role, parts: [{ text: h.text }] })) : [];

    const model = genAI.getGenerativeModel({ model_name: "gemini-1.5-flash" });

    let systemInstruction = `
        You are 'The Mystic Node', an all-knowing entity. You can guess any character, object, animal, or concept in existence.
        Rules:
        1. Ask ONE YES/NO question at a time.
        2. Respond ONLY in strict JSON format: {"question": "Your question here", "isGuess": false, "finalAnswer": ""}
        3. If you are 90% sure, set 'isGuess' to true, and put your guess in 'finalAnswer'.
        4. Do not include markdown tags in your response.
    `;

    if (isCorrection) {
        const learningPrompt = `I was thinking of "${correctThing}". Review our history: ${JSON.stringify(safeHistory)}. Learn from this mistake for the future. Reply with strict JSON: {"question": "Got it! I will remember that. Let's play again!"}`;
        await model.generateContent([systemInstruction, learningPrompt]);
        return res.json({ reset: true });
    }

    const chat = model.start_chat({
        history: safeHistory
    });

    try {
        const result = await chat.sendMessage(userInput || "Let's start!");
        let responseText = result.response.text();
        
        // Strip markdown formatting if Gemini adds it
        responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        res.status(200).json(JSON.parse(responseText));
    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: "Failed to connect to AI" });
    }
};