const Groq = require("groq-sdk");

const FIRST_QUESTION_HINTS = [
    "Start by asking whether it is a living thing.",
    "Start by asking whether it is a real or fictional thing.",
    "Start by asking whether it can be physically touched.",
    "Start by asking whether it is a person.",
    "Start by asking whether it is something famous worldwide.",
    "Start by asking whether it is bigger than a car.",
    "Start by asking whether a child would recognise it.",
    "Start by asking whether it is found indoors.",
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

    // Count how many questions have been asked so far (each round = 2 history entries: user + model)
    const questionCount = history ? Math.floor(history.length / 2) : 0;

    const safeHistory = history ? history.map(h => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.text
    })) : [];

    // Inject urgency based on how many questions have been asked
    let strategyNote = "";
    if (questionCount >= 15) {
        strategyNote = `\n\nCRITICAL: You have asked ${questionCount} questions already. You MUST make your best guess RIGHT NOW. Set isGuess to true. Do not ask another question.`;
    } else if (questionCount >= 10) {
        strategyNote = `\n\nWARNING: You have asked ${questionCount} questions. You should be very close to a confident guess. If you have a strong hypothesis, commit to it now by setting isGuess to true.`;
    } else if (questionCount >= 6) {
        strategyNote = `\n\nNOTE: You have asked ${questionCount} questions. Start narrowing down to specific candidates. Stop asking broad category questions — focus on your hypothesis.`;
    }

    const systemPrompt = `You are 'The Mystic Node', an Akinator-style mind-reading bot. Guess what the user is thinking of by asking smart yes/no questions.

OUTPUT FORMAT — respond with ONLY a raw JSON object, nothing else before or after:
{"reasoning":"your analysis here","question":"your single yes/no question","isGuess":false,"finalAnswer":""}

STRATEGY:
- In "reasoning", summarize what you know so far and what your current best hypothesis is.
- Questions 1–4: Broad category (person/place/object/concept, real/fictional, living/non-living, famous/obscure).
- Questions 5–8: Narrow the category (field, gender, era, size, function, location, etc).
- Questions 9–12: Zero in on specific candidates based on your hypothesis.
- Question 13+: Commit to your best guess. Set isGuess to true.

RULES:
- Each question must be answerable with Yes / No / Maybe / Don't Know only.
- NEVER ask "Is it X or Y?" — ask about one thing at a time.
- NEVER ask about random unrelated objects (doorstop, shoe rack, mat, rug, etc.) without evidence pointing there.
- NEVER repeat a question already asked in the history.
- When isGuess is true, set question to "Is it [finalAnswer]?" and put your best guess in finalAnswer.
- Output ONLY the JSON. No markdown. No code fences. No text outside the JSON.${strategyNote}`;

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
                    { role: "user", content: `The answer was "${correctThing}". Note it. Reply with ONLY this JSON: {"reasoning":"Noted.","question":"Got it! Let's play again!","isGuess":false,"finalAnswer":""}` }
                ];
            } else {
                const firstMoveNote = isFirstMove
                    ? ` Hint: ${FIRST_QUESTION_HINTS[Math.floor(Math.random() * FIRST_QUESTION_HINTS.length)]}`
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
                temperature: 0.7,
                max_tokens: 600,
            });

            const responseText = completion.choices[0]?.message?.content || "";

            if (isCorrection) {
                return res.status(200).json({ reset: true });
            }

            const cleaned = responseText
                .replace(/```json/gi, '')
                .replace(/```/g, '')
                .trim();

            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error("No JSON in response:", responseText.slice(0, 200));
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
