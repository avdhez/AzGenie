module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const apiKey = process.env.HF_API_KEY;
    if (!apiKey) {
        return res.status(200).json({ question: "SYSTEM ERROR: Missing HF_API_KEY in Vercel settings.", isGuess: false });
    }

    try {
        const { history, userInput, isCorrection, correctThing } = req.body;
        const safeHistory = history || [];

        // 1. Setup the System Instructions
        const messages = [
            {
                role: "system",
                content: `You are 'The Mystic Node', an Akinator-style mind-reading bot. You must figure out what the user is thinking of.
                CRITICAL RULES:
                1. You MUST phrase your question so it can ONLY be answered with "Yes", "No", "Maybe", or "Don't know".
                2. NEVER ask "A or B" questions. (e.g., NEVER ask "Is it real or fictional?". Instead ask "Is it a real person?").
                3. DO NOT GUESS IMMEDIATELY. Ask strategic, broad questions first to gather clues.
                4. Respond ONLY in strict JSON format: {"question": "Your exact yes/no question", "isGuess": false, "finalAnswer": ""}
                5. ONLY set "isGuess" to true if you are highly confident based on clues. If true, put your guess in "finalAnswer".
                6. Absolutely NO conversational filler. ONLY output the JSON object.`
            }
        ];

        // 2. Map frontend history to standard format (user -> assistant)
        safeHistory.forEach(h => {
            messages.push({
                role: h.role === 'model' ? 'assistant' : 'user',
                content: h.text
            });
        });

        if (isCorrection) {
            messages.push({
                role: "user",
                content: `I was thinking of "${correctThing}". Review our history. Learn from your mistake. Reply with strict JSON: {"question": "Got it! I will remember that. Let's play again!", "isGuess": false, "finalAnswer": ""}`
            });
        } else {
            messages.push({
                role: "user",
                content: userInput || "Let's start!"
            });
        }

        // 3. Make the API Call to Hugging Face Serverless Inference
        // Notice we append /v1/chat/completions to the model URL
        const hfModelUrl = "https://api-inference.huggingface.co/models/meta-llama/Meta-Llama-3-8B-Instruct/v1/chat/completions";

        const response = await fetch(hfModelUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "meta-llama/Meta-Llama-3-8B-Instruct",
                messages: messages,
                temperature: 0.5,
                max_tokens: 150 // Keep responses short and fast
            })
        });

        const data = await response.json();

        // 4. Handle Hugging Face Specific Errors (Cold Starts & Rate Limits)
        if (!response.ok) {
            // Hugging Face models sometimes "go to sleep" if unused. 
            // The API returns a 503 while it wakes up (takes ~20 seconds).
            if (response.status === 503) {
                 return res.status(200).json({ 
                    question: "My neural pathways are waking up! Give me about 20 seconds and click your answer again.", 
                    isGuess: false, 
                    isRateLimit: true 
                });
            }
            if (response.status === 429) {
                 return res.status(200).json({ 
                    question: "The Hugging Face servers are busy. Wait a moment and click again.", 
                    isGuess: false, 
                    isRateLimit: true 
                });
            }
            throw new Error(data.error || "Unknown Hugging Face Error");
        }

        if (isCorrection) {
            return res.status(200).json({ reset: true });
        }

        let responseText = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
        
        if (!responseText) {
            return res.status(200).json({ 
                question: "My mind went blank. Can you click your answer again?", 
                isGuess: false,
                isRateLimit: true 
            });
        }

        // 5. Bulletproof JSON Cleanup
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
             throw new Error("AI did not return valid JSON. It said: " + responseText);
        }
        
        const cleanJSON = jsonMatch[0].trim();
        res.status(200).json(JSON.parse(cleanJSON));

    } catch (error) {
        console.error("API Crash Details:", error);
        if (error.message.includes("Unexpected token") || error.message.includes("valid JSON")) {
            return res.status(200).json({ 
                question: "The magic got scrambled. Can you click your answer again?", 
                isGuess: false,
                isRateLimit: true
            });
        }
        res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
    }
};