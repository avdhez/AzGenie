const Cerebras = require("@cerebras/cerebras_cloud_sdk").default;

// Cerebras available models (in order of preference):
// "llama-3.3-70b"  — best quality, may need account approval
// "llama3.1-8b"    — always available on free tier, faster
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || "llama-3.3-70b";

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
    ]);
}

function parseJSON(text) {
    let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Format Scrambled");
    let raw = match[0].trim();

    // Attempt 1: parse as-is
    try {
        const p = JSON.parse(raw);
        if (!p.question) throw new Error("missing question");
        return p;
    } catch (_) {}

    // Attempt 2: repair common model mistakes
    let fixed = raw
        .replace(/'/g, '"')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/"(true|false|null)"/g, '$1');
    try {
        const p = JSON.parse(fixed);
        if (!p.question) throw new Error("missing question");
        return p;
    } catch (_) {}

    // Attempt 3: extract fields individually
    const get  = (k) => { const m = raw.match(new RegExp(`["']?${k}["']?\\s*:\\s*["']([\\s\\S]*?)["'](?:\\s*[,}])`)); return m ? m[1].trim() : ""; };
    const getBool = (k) => { const m = raw.match(new RegExp(`["']?${k}["']?\\s*:\\s*(true|false)`)); return m ? m[1] === 'true' : false; };
    const getNum  = (k) => { const m = raw.match(new RegExp(`["']?${k}["']?\\s*:\\s*(\\d+)`)); return m ? parseInt(m[1]) : 0; };
    const question = get("question");
    if (!question) throw new Error("Format Scrambled");
    return { reasoning: get("reasoning"), hypothesis: get("hypothesis"), question, isGuess: getBool("isGuess"), finalAnswer: get("finalAnswer"), confidence: getNum("confidence") };
}

function buildProfile(history) {
    if (!history || history.length < 2) return "";
    const tokens = [];
    for (let i = 0; i + 1 < history.length; i += 2) {
        const userTurn  = history[i];
        const modelTurn = history[i + 1];
        const answer = (userTurn?.text || "").trim().toLowerCase();
        let question = "";
        try { question = JSON.parse(modelTurn?.text || "{}").question || ""; }
        catch { question = modelTurn?.text || ""; }
        if (!question) continue;
        const tag = tagQuestion(question);
        if (!tag) continue;
        const flag = answer === "yes" ? "y" : answer === "no" ? "n" : "?";
        tokens.push(`${tag}:${flag}`);
    }
    return tokens.join(" ");
}

function tagQuestion(q) {
    q = q.toLowerCase().replace(/[?!'"]/g, "").trim();
    const map = [
        [/real.?person|actual (living )?person/,        "real-person"],
        [/fictional character|imaginary person/,         "fictional-char"],
        [/\bliving (thing|creature|organism|being)\b/,  "living-thing"],
        [/\banimal\b|\bcreature\b|\bbeast\b/,           "animal"],
        [/\bhuman\b|\bhuman being\b/,                   "human"],
        [/\bplace\b|\blocation\b|\bcountry\b|\bcity\b|\blandmark\b/, "place"],
        [/\bconcept\b|\bidea\b|\babstract\b|\bemotion\b/, "concept"],
        [/\bfood\b|\bedible\b|\beat\b|\bdrink\b|\bbeverage\b/, "food"],
        [/\bplant\b|\btree\b|\bflower\b/,               "plant"],
        [/\bvehicle\b|\btransport\b|\bcar\b|\bship\b/,  "vehicle"],
        [/\bsport\b|\bgame\b|\bactivity\b/,             "sport-game"],
        [/\bevent\b|\bholiday\b|\bfestival\b/,          "event"],
        [/\bweapon\b/,                                  "weapon"],
        [/\bbuilding\b|\bstructure\b|\bmonument\b/,     "structure"],
        [/\bdevice\b|\bgadget\b|\btechnology\b/,        "tech-device"],
        [/\bmovie\b|\bfilm\b|\bshow\b|\bseries\b/,      "media-title"],
        [/\bsong\b|\btrack\b|\balbum\b/,                "music-title"],
        [/\bbook\b|\bnovel\b/,                          "book-title"],
        [/video game|game title/,                       "game-title"],
        [/hold in (your|one) hand|fits? in.*pocket/,    "handheld"],
        [/bigger than a car|large|enormous/,             "large"],
        [/smaller than|tiny|miniature/,                  "small"],
        [/found indoors|inside.*home/,                   "indoor"],
        [/outdoors|outside|in nature/,                   "outdoor"],
        [/man.?made|manufactured/,                       "man-made"],
        [/\bnatural\b|occurs in nature/,                 "natural"],
        [/electronic|digital/,                           "electronic"],
        [/\bmale\b|is.*a man\b/,                        "male"],
        [/\bfemale\b|\bwoman\b/,                        "female"],
        [/still alive|currently alive/,                  "alive"],
        [/dead|deceased|passed away/,                    "deceased"],
        [/\bactor\b|\bactress\b/,                       "actor"],
        [/\bmusician\b|\bsinger\b|\brapper\b/,          "musician"],
        [/youtube|content.?creator|streamer/,            "youtuber"],
        [/\bathlete\b|\bsport(sman|swoman|sperson)\b/,  "athlete"],
        [/\bpolitician\b|\bpresident\b|\bminister\b/,   "politician"],
        [/\bcomedian\b/,                                "comedian"],
        [/\bscientist\b|\binventor\b/,                  "scientist"],
        [/\bceo\b|\bentrepreneur\b/,                    "business"],
        [/\bamerican\b|\bunited states\b/,               "american"],
        [/\bbritish\b|\buk\b/,                          "british"],
        [/\bindian\b/,                                  "indian"],
        [/\basian\b/,                                   "asian"],
        [/\beuropean\b/,                                "european"],
        [/under 30|in.*20s/,                            "under30"],
        [/30.?50|middle.?aged/,                         "mid-age"],
        [/over 50|older|senior/,                        "older"],
        [/globally famous|worldwide/,                    "global-fame"],
        [/\banime\b/,                                   "anime"],
        [/\bmanga\b/,                                   "manga"],
        [/comic book|marvel|dc\b/,                      "comic"],
        [/\bcartoon\b/,                                 "cartoon"],
        [/video game character/,                        "game-char"],
        [/\bsuperhero\b|super.?power/,                  "superhero"],
        [/\bvillain\b|\bantagonist\b/,                  "villain"],
        [/\bsupernatural\b|\bmagic\b/,                  "supernatural"],
        [/\brobot\b|\bandroid\b/,                       "robot"],
        [/\balien\b/,                                   "alien"],
        [/\bmammal\b/,                                  "mammal"],
        [/\bbird\b/,                                    "bird"],
        [/\bfish\b|\baquatic\b/,                        "aquatic"],
        [/\binsect\b|\bbug\b/,                          "insect"],
        [/\bcontinent\b/,                               "continent"],
        [/\bisland\b/,                                  "island"],
        [/tourist|landmark/,                            "landmark"],
        [/\bsweet\b|\bdessert\b/,                       "sweet-food"],
        [/\bfruit\b|\bvegetable\b/,                     "produce"],
        [/\bmeat\b/,                                    "meat-food"],
        [/award|oscar|grammy|emmy/,                     "award-winner"],
        [/has.?screen|\bdisplay\b/,                     "has-screen"],
        [/\bwheels?\b/,                                 "has-wheels"],
        [/made of (metal|wood|plastic|glass)/,          "material"],
    ];
    for (const [pattern, tag] of map) {
        if (pattern.test(q)) return tag;
    }
    const words = q
        .replace(/^(is it|does this|is this|has this|can this|was this|did this|do they|are they|would this|can you|could this)\s*/i, "")
        .split(/\s+/).slice(0, 3).join("-");
    return words.length > 3 ? words : null;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.CEREBRAS_API_KEYS;
    if (!keysString) return res.status(200).json({ question: "SYSTEM ERROR: Missing CEREBRAS_API_KEYS.", isGuess: false });

    let keyArray = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);
    keyArray = keyArray.sort(() => 0.5 - Math.random());

    const { history, userInput, isCorrection, correctThing } = req.body;
    const isFirstMove = !history || history.length === 0;
    const qCount = history ? Math.floor(history.length / 2) : 0;

    const safeHistory = history ? history.map(h => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.text
    })) : [];

    if (isCorrection) {
        for (let i = 0; i < keyArray.length; i++) {
            try {
                const client = new Cerebras({ apiKey: keyArray[i] });
                await withTimeout(client.chat.completions.create({
                    model: CEREBRAS_MODEL,
                    messages: [
                        { role: "system", content: `Reply ONLY with this JSON: {"reasoning":"Noted.","hypothesis":"","question":"The Jinn learns from every defeat. Shall we play again?","isGuess":false,"finalAnswer":"","confidence":0}` },
                        { role: "user", content: `Answer was "${correctThing}".` }
                    ],
                    max_completion_tokens: 80,
                }), 10000);
                break;
            } catch {}
        }
        return res.status(200).json({ reset: true });
    }

    const profile = buildProfile(history || []);

    let phaseNote = "";
    if (qCount >= 18)      phaseNote = `FORCE-GUESS: ${qCount} questions used. Set isGuess:true now.`;
    else if (qCount >= 12) phaseNote = `COMMIT: ${qCount}q done. Guess if confidence>=80. Else one final sharp question.`;
    else if (qCount >= 7)  phaseNote = `VERIFY: ${qCount}q done. Confirm hypothesis via indirect attributes. Guess if confidence>=80.`;
    else if (qCount >= 3)  phaseNote = `NARROW: ${qCount}q done. Entity type likely known. Drill specific attributes.`;
    else                   phaseNote = `EXPLORE: ${qCount}q done. Determine what KIND of thing this is first.`;

    const systemPrompt = `You are Avdhez the Jinn — a mind reader playing a guessing game. The user is thinking of something. It could be ANYTHING: a real person, fictional character, animal, object, place, food, vehicle, concept, event, plant, instrument, sport, movie, song, building — literally anything.

PROFILE STRING — compact summary of all answers so far:
"${profile || "empty — no answers yet"}"

Each token: tag:y = confirmed YES, tag:n = confirmed NO, tag:? = maybe.

OUTPUT — raw JSON only, nothing before or after, no markdown:
{"reasoning":"...","hypothesis":"...","question":"...","isGuess":false,"finalAnswer":"","confidence":0}

HOW TO REASON (write fully in "reasoning"):
1. READ :y tags — what confirmed picture do they form together?
2. READ :n tags — what is completely eliminated?
3. HYPOTHESIZE — top 2-3 specific guesses with % probability each, justified by :y tags
4. FIND THE GAP — what single unknown would most help distinguish between hypotheses?
5. FORM QUESTION — what yes/no question fills that gap AND gives useful info if answered No?

ADAPTIVE QUESTIONING — let the profile drive you, no fixed script:
- Profile empty → ask broadest split: living thing? person? physical object?
- living-thing:y + human:n → animal confirmed. Ask: domestic? mammal? bird?
- real-person:y → ask gender, field, region, era in whatever order makes sense next
- fictional-char:y → ask medium (anime/comic/game/movie), genre, then traits
- food:y → ask sweet/savory, fruit/vegetable/meat, raw/cooked, origin
- place:y → ask continent, natural/man-made, famous landmark, size
- object:y / tech-device:y → ask handheld, electronic, indoor, function
- concept:y → ask positive/negative, universal/cultural, abstract/tangible
- media-title:y → ask genre, era, origin, global or niche fame

QUESTION RULES:
- Never ask about a tag already in the profile
- Never say "Is it X or Y?" — one subject per question only
- Never name your hypothesis in the question until final guess
- Each question must naturally follow from confirmed :y tags
- Aim to split remaining possibilities roughly in half
- Use indirect property questions to verify before naming hypothesis

GUESSING — when confidence >= 80:
Set isGuess:true, put specific answer in finalAnswer, question = "Is it [finalAnswer]?"
finalAnswer must be specific: "MrBeast", "Spider-Man", "Eiffel Tower", "a dolphin", "Pizza".

${phaseNote}`;

    let lastError = null;

    for (let i = 0; i < keyArray.length; i++) {
        try {
            const client = new Cerebras({ apiKey: keyArray[i] });

            const messages = [
                { role: "system", content: systemPrompt },
                ...safeHistory,
                { role: "user", content: userInput || "Let's start!" }
            ];

            const completion = await withTimeout(
                client.chat.completions.create({
                    model: CEREBRAS_MODEL,
                    messages,
                    max_completion_tokens: 800,
                }),
                14000
            );

            const raw = completion.choices[0]?.message?.content || "";
            const parsed = parseJSON(raw);
            const confidence = parsed.confidence || 0;

            console.log(`Q${qCount+1} | profile:"${profile}" | hyp:"${parsed.hypothesis}" | conf:${confidence}%`);

            if (parsed.isGuess && confidence < 80) {
                console.log(`Guess blocked (${confidence}%). Requesting verification.`);
                const verifyMessages = [
                    {
                        role: "system",
                        content: `You are Avdhez the Jinn. Profile: "${profile}". Hypothesis: "${parsed.hypothesis || parsed.finalAnswer}", confidence: ${confidence}% (need 80%).
Ask ONE indirect yes/no question about a property of "${parsed.hypothesis || parsed.finalAnswer}" that does NOT name it and pushes confidence above 80%.
Reply ONLY with JSON: {"reasoning":"why","hypothesis":"${parsed.hypothesis || parsed.finalAnswer}","question":"indirect question","isGuess":false,"finalAnswer":"","confidence":${confidence}}`
                    },
                    ...safeHistory,
                    { role: "user", content: userInput || "continue" }
                ];
                try {
                    const vc = await withTimeout(client.chat.completions.create({
                        model: "llama-3.3-70b",
                        messages: verifyMessages,
                        max_completion_tokens: 300,
                    }), 12000);
                    const vp = parseJSON(vc.choices[0]?.message?.content || "");
                    return res.status(200).json({ question: vp.question, isGuess: false, finalAnswer: "" });
                } catch {
                    return res.status(200).json({ question: parsed.question, isGuess: false, finalAnswer: "" });
                }
            }

            return res.status(200).json({
                question: parsed.question,
                isGuess: parsed.isGuess || false,
                finalAnswer: parsed.finalAnswer || ""
            });

        } catch (error) {
            const msg = (error.message || "").toLowerCase();
            const status = error.status || error.statusCode;
            lastError = error;
            console.error(`Key${i+1}/${keyArray.length} — ${status} | ${error.message}`);

            if (
                msg.includes('timeout') ||
                status === 429 || msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") ||
                status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("expired") ||
                status === 400 || msg.includes("restricted") || msg.includes("suspended") || msg.includes("banned")
            ) continue;

            if (msg.includes("format scrambled") || msg.includes("unexpected token")) {
                return res.status(200).json({ question: "The vision blurred — click your answer again.", isGuess: false, isRateLimit: true });
            }

            return res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
        }
    }

    return res.status(200).json({
        question: "The Jinn needs a moment to recover. Please try again.",
        isGuess: false,
        isRateLimit: true
    });
};