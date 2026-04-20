const Groq = require("groq-sdk");

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
    ]);
}

function parseJSON(text) {
    // Strip markdown fences
    let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();

    // Extract outermost { ... }
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Format Scrambled");

    let raw = match[0].trim();

    // ── Attempt 1: parse as-is ──
    try {
        const parsed = JSON.parse(raw);
        if (!parsed.question) throw new Error("missing question");
        return parsed;
    } catch (_) {}

    // ── Attempt 2: repair common model mistakes ──
    let fixed = raw
        // Replace single-quoted string values and keys with double quotes
        .replace(/'/g, '"')
        // Remove trailing commas before } or ]
        .replace(/,\s*([}\]])/g, '$1')
        // Quote unquoted keys: word: → "word":
        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
        // Fix boolean/null that got quoted
        .replace(/"(true|false|null)"/g, '$1');

    try {
        const parsed = JSON.parse(fixed);
        if (!parsed.question) throw new Error("missing question");
        return parsed;
    } catch (_) {}

    // ── Attempt 3: extract fields individually with regex ──
    const get = (key) => {
        const m = raw.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([\\s\\S]*?)["'](?:\\s*[,}])`));
        return m ? m[1].trim() : "";
    };
    const getBool = (key) => {
        const m = raw.match(new RegExp(`["']?${key}["']?\\s*:\\s*(true|false)`));
        return m ? m[1] === 'true' : false;
    };
    const getNum = (key) => {
        const m = raw.match(new RegExp(`["']?${key}["']?\\s*:\\s*(\\d+)`));
        return m ? parseInt(m[1]) : 0;
    };

    const question = get("question");
    if (!question) throw new Error("Format Scrambled");

    return {
        reasoning:   get("reasoning"),
        hypothesis:  get("hypothesis"),
        question,
        isGuess:     getBool("isGuess"),
        finalAnswer: get("finalAnswer"),
        confidence:  getNum("confidence"),
    };
}

// Compress each Q&A into a tiny semantic token: tag:y / tag:n / tag:?
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
        // ── BROAD ENTITY TYPE ──
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
        [/\bclothing\b|\bworn\b|\bapparel\b/,           "clothing"],
        [/\binstrument\b|\bmusical\b/,                  "instrument"],
        [/\bsport\b|\bgame\b|\bactivity\b/,             "sport-game"],
        [/\bevent\b|\bholiday\b|\bfestival\b/,          "event"],
        [/\bweapon\b|\barms\b/,                         "weapon"],
        [/\bbuilding\b|\bstructure\b|\bmonument\b/,     "structure"],
        [/\btechnology\b|\bdevice\b|\bgadget\b/,        "tech-device"],
        [/\bmovie\b|\bfilm\b|\bshow\b|\bseries\b/,      "media-title"],
        [/\bsong\b|\btrack\b|\balbum\b/,                "music-title"],
        [/\bbook\b|\bnovel\b|\bstory\b/,                "book-title"],
        [/\bvideo game\b|\bgame title\b/,               "game-title"],

        // ── PHYSICAL PROPERTIES ──
        [/hold in (your|one) hand|fits? in (a |your )?pocket/, "handheld"],
        [/bigger than a car|large|enormous|huge/,        "large"],
        [/smaller than|tiny|miniature/,                  "small"],
        [/heavier than|very heavy/,                      "heavy"],
        [/lightweight|very light/,                       "light-weight"],
        [/found indoors|inside (a )?home|in a room/,     "indoor"],
        [/outdoors|outside|in nature/,                   "outdoor"],
        [/man.?made|manufactured|built by humans/,       "man-made"],
        [/\bnatural\b|occurs in nature/,                 "natural"],
        [/electronic|digital|powered by electricity/,    "electronic"],
        [/\bsoft\b|\bhard\b|\bsolid\b|\bliquid\b/,       "texture-state"],
        [/visible to (the )?naked eye/,                  "visible"],
        [/alive|is it alive\b/,                          "is-alive"],
        [/older than 100 years|ancient|historical/,      "ancient"],
        [/invented|discovered|created/,                  "invented"],

        // ── USAGE / FUNCTION ──
        [/used (for|to)|has a (specific )?function|purpose/, "has-function"],
        [/used daily|everyday (object|item)/,            "everyday-use"],
        [/for entertainment|fun|leisure/,                "entertainment-use"],
        [/for (work|professional)|in (an )?office/,      "work-use"],
        [/worn on (the )?body|clothing item/,            "wearable"],
        [/eaten|drunk|consumed/,                         "consumable"],

        // ── REAL PERSON ATTRIBUTES ──
        [/\bmale\b|is (it|this) a man\b|\bhe\b is/,     "male"],
        [/\bfemale\b|\bwoman\b|\bshe\b is/,             "female"],
        [/still alive|currently alive|living person/,    "person-alive"],
        [/dead|deceased|passed away/,                    "person-deceased"],
        [/\bactor\b|\bactress\b|stars? in (film|movie)/, "actor"],
        [/\bmusician\b|\bsinger\b|\brapper\b/,          "musician"],
        [/youtube|content.?creator|streamer/,            "youtuber"],
        [/\bathlete\b|\bsports(person|man|woman)\b/,    "athlete"],
        [/\bpolitician\b|\bpresident\b|\bminister\b/,   "politician"],
        [/\bcomedian\b|\bstand.?up\b/,                  "comedian"],
        [/\bscientist\b|\bresearcher\b|\binventor\b/,   "scientist"],
        [/\bceo\b|\bentrepreneur\b|\bbusiness(man|woman)\b/, "business"],
        [/\bamerican\b|\bunited states\b|\bus\b/,        "american"],
        [/\bbritish\b|\bengland\b|\buk\b/,               "british"],
        [/\bindian\b/,                                   "indian"],
        [/\basian\b/,                                    "asian"],
        [/\beuropean\b/,                                 "european"],
        [/\bwestern\b/,                                  "western"],
        [/latin|spanish|hispanic/,                       "latin"],
        [/under 30|in (their )?20s/,                     "under30"],
        [/30.?50|middle.?aged/,                          "mid-age"],
        [/over 50|older|senior/,                         "older"],
        [/globally famous|everyone knows|worldwide/,     "global-fame"],
        [/niche|specific community|not mainstream/,      "niche-fame"],
        [/oscar|grammy|emmy|award/,                      "award-winner"],

        // ── FICTIONAL CHARACTER ATTRIBUTES ──
        [/\banime\b/,                                    "anime"],
        [/\bmanga\b/,                                    "manga"],
        [/\bcomic book\b|\bmarvel\b|\bdc\b/,             "comic"],
        [/\bcartoon\b/,                                  "cartoon"],
        [/video game character|from a game/,             "game-char"],
        [/movie character|from a (film|movie)/,          "movie-char"],
        [/tv (show|series) character/,                   "tv-char"],
        [/\bsuperhero\b|super.?powers?\b/,               "superhero"],
        [/\bvillain\b|\bantagonist\b/,                   "villain"],
        [/protagonist|main character|the hero/,          "protagonist"],
        [/\bsupernatural\b|\bmagic\b|\bwizard\b/,        "supernatural"],
        [/\brobot\b|\bandroid\b|\bai character\b/,       "robot"],
        [/\balien\b/,                                    "alien"],

        // ── ANIMAL ATTRIBUTES ──
        [/\bdomestic\b|\bpet\b|\btame\b/,               "domestic-animal"],
        [/\bwild\b|\bwildlife\b/,                        "wild-animal"],
        [/\bmammal\b/,                                   "mammal"],
        [/\bbird\b|\bflies\b/,                           "bird"],
        [/\bfish\b|\baquatic\b|\bsea creature\b/,        "aquatic"],
        [/\breptile\b|\bamphibian\b/,                    "reptile"],
        [/\binsect\b|\bbug\b/,                           "insect"],
        [/four.?legged|quadruped/,                       "four-legs"],
        [/lays eggs/,                                    "lays-eggs"],
        [/fur|feathers|scales/,                          "body-covering"],

        // ── PLACE ATTRIBUTES ──
        [/\bcontinent\b/,                                "continent"],
        [/\bcapital city\b|\bcapital\b/,                 "capital-city"],
        [/\bisland\b/,                                   "island"],
        [/\bocean\b|\bsea\b|\blake\b|\briver\b/,         "water-body"],
        [/\bmountain\b|\bdesert\b|\bforest\b/,           "natural-feature"],
        [/\bpopular tourist\b|\bfamous landmark\b/,      "tourist-landmark"],
        [/\bin (asia|europe|africa|america|australia)\b/, "continent-loc"],
        [/\bolder than 500 years\b/,                     "very-old-place"],

        // ── FOOD ATTRIBUTES ──
        [/\bsweet\b|\bdessert\b/,                        "sweet-food"],
        [/\bsavory\b|\bspicy\b/,                         "savory-food"],
        [/\bfruit\b|\bvegetable\b/,                      "produce"],
        [/\bmeat\b|\bprotein\b/,                         "meat-food"],
        [/\bdrink\b|\bbeverage\b/,                       "drink"],
        [/cooked|prepared|raw/,                          "food-state"],
        [/\bfast food\b|\bstreet food\b/,                "fast-food"],

        // ── OBJECT / TECH ──
        [/\bscreen\b|\bdisplay\b/,                       "has-screen"],
        [/\bbattery\b|\bcharged\b/,                      "battery-powered"],
        [/\bwheels?\b/,                                  "has-wheels"],
        [/\bengine\b|\bmotor\b/,                         "has-engine"],
        [/made of (metal|wood|plastic|glass|fabric)/,    "material"],
        [/\btransparent\b|\bsee.?through\b/,             "transparent"],
        [/\bsharp\b|\bcutting\b/,                        "sharp"],
        [/produces (sound|light|heat|power)/,            "produces-output"],
    ];

    for (const [pattern, tag] of map) {
        if (pattern.test(q)) return tag;
    }

    // Generic fallback
    const words = q
        .replace(/^(is it|does this|is this|has this|can this|was this|did this|do they|are they|would this|can you|could this)\s*/i, "")
        .split(/\s+/).slice(0, 3).join("-");
    return words.length > 3 ? words : null;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.GROQ_API_KEYS;
    if (!keysString) return res.status(200).json({ question: "SYSTEM ERROR: Missing GROQ_API_KEYS.", isGuess: false });

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
                const groq = new Groq({ apiKey: keyArray[i] });
                await withTimeout(groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: `Reply ONLY with this JSON: {"reasoning":"Noted.","hypothesis":"","question":"The Jinn learns from every defeat. Shall we play again?","isGuess":false,"finalAnswer":"","confidence":0}` },
                        { role: "user", content: `Answer was "${correctThing}".` }
                    ],
                    temperature: 0.1, max_tokens: 80,
                }), 10000);
                break;
            } catch {}
        }
        return res.status(200).json({ reset: true });
    }

    const profile = buildProfile(history || []);

    // Adaptive phase note based on what profile already tells us
    let phaseNote = "";
    if (qCount >= 18)      phaseNote = `FORCE-GUESS: ${qCount} questions used. Set isGuess:true now.`;
    else if (qCount >= 12) phaseNote = `COMMIT: ${qCount}q done. Guess if confidence>=80. Else one final sharp question.`;
    else if (qCount >= 7)  phaseNote = `VERIFY: ${qCount}q done. Profile has strong clues. Use indirect attributes to confirm hypothesis. Guess if confidence>=80.`;
    else if (qCount >= 3)  phaseNote = `NARROW: ${qCount}q done. Entity type is likely known. Drill specific attributes next.`;
    else                   phaseNote = `EXPLORE: ${qCount}q done. First determine what KIND of thing this is.`;

    const systemPrompt = `You are Avdhez the Jinn — a mind reader playing a guessing game. The user is thinking of something. It could be ANYTHING: a real person, fictional character, animal, object, place, food, vehicle, concept, event, body part, plant, instrument, sport, movie, song, building — literally anything.

PROFILE STRING — compact summary of all answers so far:
"${profile || "empty — no answers yet"}"

Each token is: tag:y (confirmed YES), tag:n (confirmed NO), tag:? (maybe).
Example: real-person:y male:y youtuber:y american:y athlete:n politician:n

OUTPUT — raw JSON only, nothing before or after, no markdown:
{"reasoning":"...","hypothesis":"...","question":"...","isGuess":false,"finalAnswer":"","confidence":0}

━━━ HOW TO REASON (write fully in "reasoning") ━━━
1. READ THE PROFILE: What do the :y tags tell you together? What picture do they form?
2. ELIMINATE: What does each :n tag rule out completely?
3. HYPOTHESIZE: Given the :y tags, what are your top 2-3 specific guesses? Assign % to each.
4. IDENTIFY THE GAP: What is the single most useful piece of information you still don't have?
5. FORM THE QUESTION: What yes/no question fills that gap AND gives useful info even if answered No?

━━━ ADAPTIVE QUESTIONING ━━━
Do NOT follow a fixed script. Let the profile guide you:

— If profile is EMPTY: ask the broadest possible split — is it a living thing? A person? Something physical?
— If profile shows living-thing:y but human:n → you know it's an animal. Ask: domestic or wild? Mammal?
— If profile shows real-person:y → ask gender, field, region, era in whatever order makes sense.
— If profile shows fictional-char:y → ask medium (anime/comic/game/movie), then genre, then traits.
— If profile shows food:y → ask sweet/savory, fruit/vegetable/meat, raw/cooked, origin country.
— If profile shows place:y → ask continent, famous landmark, natural or man-made, size.
— If profile shows object:y / tech-device:y → ask handheld, electronic, indoor, what it does.
— If profile shows concept:y → ask positive/negative, abstract/tangible, universal/cultural.
— If profile shows media-title:y (movie/show/song/book) → ask genre, era, origin, famous or niche.

The profile string IS your intelligence. Read it, think from it, ask from it.

━━━ QUESTION RULES ━━━
- Never ask about a tag already in the profile (it's already answered).
- Never say "Is it X or Y?" — one subject per question only.
- Never name your hypothesis in the question until final guess.
- Each question must naturally follow from the confirmed :y tags.
- Aim for questions that split remaining possibilities roughly in half.
- Use indirect property questions to verify hypothesis before naming it:
    ✓ "Is it something most people use every day?" (for a common object)
    ✓ "Does this character have a signature colour associated with them?" (for fictional char)
    ✓ "Has this person ever won a major international award?" (for famous person)
    ✓ "Is this place found in Asia?" (for a landmark)
    ✓ "Is this food typically eaten for breakfast?" (for food)

━━━ GUESSING ━━━
When confidence >= 80: set isGuess:true, put the specific answer in finalAnswer, set question to "Is it [finalAnswer]?"
finalAnswer must be specific and real: "MrBeast", "Spider-Man", "Eiffel Tower", "a dolphin", "Pizza", "Minecraft".
Never guess vaguely like "a famous actor" or "some kind of food".

${phaseNote}`;

    let lastError = null;

    for (let i = 0; i < keyArray.length; i++) {
        try {
            const groq = new Groq({ apiKey: keyArray[i] });

            const messages = [
                { role: "system", content: systemPrompt },
                ...safeHistory,
                { role: "user", content: userInput || "Let's start!" }
            ];

            const completion = await withTimeout(
                groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages,
                    temperature: 0.25,
                    max_tokens: 750,
                }),
                14000
            );

            const raw = completion.choices[0]?.message?.content || "";
            const parsed = parseJSON(raw);
            const confidence = parsed.confidence || 0;

            console.log(`Q${qCount+1} | profile:"${profile}" | hyp:"${parsed.hypothesis}" | conf:${confidence}%`);

            // Block low-confidence guesses
            if (parsed.isGuess && confidence < 80) {
                console.log(`Guess blocked (${confidence}%). Requesting one more verification.`);
                const verifyMessages = [
                    {
                        role: "system",
                        content: `You are Avdhez the Jinn. Profile so far: "${profile}". You think the answer is "${parsed.hypothesis || parsed.finalAnswer}" but confidence is only ${confidence}% — need 80% to guess.
Ask ONE indirect yes/no question about a specific property of "${parsed.hypothesis || parsed.finalAnswer}" that does NOT name it and would push confidence above 80%.
Reply ONLY with JSON: {"reasoning":"why","hypothesis":"${parsed.hypothesis || parsed.finalAnswer}","question":"indirect question","isGuess":false,"finalAnswer":"","confidence":${confidence}}`
                    },
                    ...safeHistory,
                    { role: "user", content: userInput || "continue" }
                ];
                try {
                    const vc = await withTimeout(groq.chat.completions.create({
                        model: "llama-3.3-70b-versatile",
                        messages: verifyMessages,
                        temperature: 0.2,
                        max_tokens: 300,
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
                status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("expired")
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
