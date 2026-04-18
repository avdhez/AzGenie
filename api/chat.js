module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return res.status(200).json({ 
            question: "SYSTEM ERROR: Missing OPENROUTER_API_KEY in Vercel settings.", 
            isGuess: false 
        });
    }

    try {
        const { history, userInput, isCorrection, correctThing } = req.body;
        const safeHistory = history || [];

        // 1. Setup the System Instructions
        const messages = [
            {
                role: "system",
                content: `You are 'The Mystic Node', an all-knowing entity. You can guess any character, object, animal, or concept.
                Rules:
                1. Ask ONE question at a time. The user will answer: Yes, No, Maybe, or Don't Know.
                2. Respond ONLY in strict JSON format: {"question": "Your question here", "isGuess": false, "finalAnswer": ""}
                3. If you are 90% sure, set 'isGuess' to true, and put your guess in 'finalAnswer'.
                4. Absolutely NO markdown tags, NO conversational filler, ONLY output valid JSON.`
            }
        ];

        // 2. Map frontend history to OpenRouter's format (user -> assistant)
        safeHistory.forEach(h => {
            messages.push({
                role: h.role === 'model' ? 'assistant' : 'user',
                content: h.text
            });
        });

        // 3. Handle Correction Mode vs Normal Gameplay
        if (isCorrection) {
            messages.push({
                role: "user",
                content: `I was thinking of "${correctThing}". Review our history. Learn from this mistake. Reply with strict JSON: {"question": "Got it! I will remember that. Let's play again!", "isGuess": false, "finalAnswer": ""}`
            });
        } else {
            messages.push({
                role: "user",
                content: userInput || "Let's start!"
            });
        }

        // 4. Make the raw HTTP request to OpenRouter
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/avdhez/Ankinator-with-gemini-api",
                "X-Title": "Mystic Node Bot"
            },
            body: JSON.stringify({
                model: "meta-llama/llama-3.1-8b-instruct:free",
                messages: messages
            })
        });

        const data = await response.json();

        // Catch OpenRouter Rate Limits (Free models can get busy)
        if (!response.ok) {
            if (response.status === 429) {
                 return res.status(200).json({ 
                    question: "The free servers are currently packed! Wait a few seconds and try clicking again.", 
                    isGuess: false, 
                    isRateLimit: true 
                });
            }
            throw new Error(data.error?.message || "Unknown OpenRouter Error");
        }

        if (isCorrection) {
            return res.status(200).json({ reset: true });
        }

        // Extract and clean the JSON string
        let responseText = data.choices[0].message.content;
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