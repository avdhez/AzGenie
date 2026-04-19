const Groq = require("groq-sdk");

const FIRST_QUESTION_HINTS = [
    "Start by asking about whether it is a living thing.",
    "Start by asking about whether it is a real or fictional thing.",
    "Start by asking about whether it can be physically touched.",
    "Start by asking about whether it is something famous worldwide.",
    "Start by asking about whether it is a person.",
    "Start by asking about whether it exists in the real world.",
    "Start by asking about whether it is bigger than a car.",
    "Start by asking about whether a child would know what it is.",
];

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.GROQ_API_KEYS;
    if (!keysString) {
        return res.status(200).json({ question: "SYSTEM ERROR: Missing GROQ_API_KEYS.", isGuess: false });
    }

    let keyArray = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);
    keyArray = keyArray.sort(() => 0.5 - Math.random());

    const { history, userInput, isCorrection, correctThing } = req.body;

    const isFirstMove = !history || history.length === 0;

    const safeHistory = history ? history.map(h => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.text
    })) : [];

    const systemPrompt = `You are 'The Mystic Node', an Akinator-style mind-reading bot. Your goal is to guess what the user is thinking of by asking yes/no questions one at a time.

You MUST always respond with ONLY a raw JSON object in this exact format with no extra text before or after:
{"reasoning":"your thinking here","question":"your yes/no question here","isGuess":false,"finalAnswer":""}

STRATEGY:
- Use "reasoning" to analyze clues gathered so far before forming your next question.
- Start broad: is it real or fictional? A person, place, object, or concept? Living or non-living?
- After 5-7 answers, form a strong hypothesis. After 10+ answers, commit to a guess.
- When guessing set isGuess to true and put your answer in finalAnswer. Set question to "Is it [finalAnswer]?"

STRICT RULES:
- One question at a time, answerable only with Yes / No / Maybe / Don't Know.
- Never ask "Is it A or B?" — ask each separately.
- Output ONLY the JSON object. No markdown. No code fences. No explanation outside the JSON.`;

    let lastError = null;

    for (let i = 0; i < keyArray.length; i++) {
        const currentKey = keyArray[i];

        try {
            const groq = new Groq({ apiKey: currentKey });

            let messages;

            if (isCorrection) {
                messages = [
                    { role: "system", content: systemPrompt },
                    ...safeHistory,
                    { role: "user", content: `The answer was "${correctThing}". Note it for the future. Reply with ONLY this JSON: {"reasoning":"Noted.","question":"Understood! Let's play again!","isGuess":false,"finalAnswer":""}` }
                ];
            } else {
                // Inject a random hint on the very first move to vary the opening question
                const firstMoveNote = isFirstMove
                    ? ` Hint for your first question only: ${FIRST_QUESTION_HINTS[Math.floor(Math.random() * FIRST_QUESTION_HINTS.length)]}`
                    : "";

                messages = [
                    { role: "system", content: systemPrompt + firstMoveNote },
                    ...safeHistory,
                    { role: "user", content: userInput || "Let's start!" }
                ];
            }

            const completion = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages,
                temperature: 0.8,
                max_tokens: 600,
            });

            const responseText = completion.choices[0]?.message?.content || "";

            if (isCorrection) {
                return res.status(200).json({ reset: true });
            }

            // Strip markdown fences if present
            const cleaned = responseText
                .replace(/```json/gi, '')
                .replace(/```/g, '')
                .trim();

            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error("No JSON found in response:", responseText.slice(0, 200));
                throw new Error("Format Scrambled");
            }

            const parsed = JSON.parse(jsonMatch[0].trim());
            if (!parsed.question) throw new Error("Format Scrambled: missing question");

            return res.status(200).json({
                question: parsed.question,
                isGuess: parsed.isGuess || false,
                finalAnswer: parsed.finalAnswer || ""
            });

        } catch (error) {
            const msg = (error.message || "").toLowerCase();
            const status = error.status || error.statusCode || error.code;

            lastError = `Key${i + 1} | status:${status} | ${error.message}`;
            console.error(lastError);

            if (status === 429 || msg.includes("429") || msg.includes("quota") || msg.includes("rate limit")) {
                continue;
            }
            if (status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("expired")) {
                continue;
            }
            if (msg.includes("format scrambled") || msg.includes("unexpected token")) {
                return res.status(200).json({
                    question: "The magic got scrambled. Can you click your answer again?",
                    isGuess: false,
                    isRateLimit: true
                });
            }

            return res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
        }
    }

    return res.status(200).json({
        question: `All ${keyArray.length} neural pathways are rate-limited. Please wait a moment and try again.`,
        isGuess: false,
        isRateLimit: true
    });
};
