import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { MongoClient, type Collection } from "mongodb";

let words: Collection | null = null;

const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
  console.error("MONGO_URI is not set (expected in .env)");
  process.exit(1);
}

new MongoClient(mongoUri)
  .connect()
  .then((c) => {
    const db = c.db("james-extension");
    words = db.collection("words");
    console.log("mongo connected");
  })
  .catch((e) => console.error("mongo connect failed:", e));

const PROJECTION = {
  word: 1,
  phonetic: 1,
  phonetic_us: 1,
  phonetic_uk: 1,
  pos: 1,
  senses: 1,
  target_parts: 1,
  confusable_with: 1,
  synonyms: 1,
  related: 1,
  forms: 1,
  word_family: 1,
  phrases: 1,
  dependent_preposition: 1,
  toeic_tip: 1,
  antonyms: 1,
  primary_example: 1,
  examples: 1,
  level: 1,
  audio_url: 1,
  audio_us: 1,
  audio_uk: 1,
  image_url: 1,
};

const POS_RE =
  /danh từ|động từ|tính từ|trạng từ|giới từ|đại từ|thán từ|liên từ|mạo từ|số từ|phó từ|trợ động từ|hậu tố|tiền tố|định ngữ|phân từ/i;

function shapeWord(doc: any) {
  // Keep the longest pos string per Vietnamese POS category
  const byPos = new Map<string, string>();
  for (const p of doc.pos ?? []) {
    const m = p.match(POS_RE);
    if (!m || /[+:]/.test(p)) continue;
    const cur = byPos.get(m[0]);
    if (!cur || p.length > cur.length) byPos.set(m[0], p);
  }

  let examples = doc.examples ?? [];
  if (
    doc.primary_example &&
    !examples.some((e: any) => e.en === doc.primary_example.en)
  ) {
    examples = [doc.primary_example, ...examples];
  }

  return {
    word: doc.word,
    phonetic: doc.phonetic || doc.phonetic_us || doc.phonetic_uk,
    phonetic_us: doc.phonetic_us || doc.phonetic,
    phonetic_uk: doc.phonetic_uk || doc.phonetic,
    pos: byPos.size ? [...byPos.values()] : (doc.pos ?? []),
    meaning: doc.senses?.[0],
    senses: (doc.senses ?? []).slice(0, 5),
    target_parts: doc.target_parts ?? [],
    confusable_with: doc.confusable_with ?? null,
    synonyms: doc.synonyms?.length ? doc.synonyms : (doc.related ?? []),
    antonyms: doc.antonyms ?? [],
    forms: doc.forms ?? [],
    word_family: doc.word_family ?? [],
    phrases: doc.phrases ?? [],
    dependent_preposition: doc.dependent_preposition ?? null,
    toeic_tip: doc.toeic_tip ?? null,
    example: doc.primary_example ?? examples[0] ?? null,
    examples,
    level: doc.level ?? null,
    audio: doc.audio_url || doc.audio_us,
    audio_us: doc.audio_us || doc.audio_url,
    audio_uk: doc.audio_uk,
    image: doc.image_url,
  };
}

// ponytail: in-memory per-IP limiter — resets on restart, won't scale
// across multiple instances; upgrade path = Redis or edge rule (CF rate limiting).
const WINDOW_MS = 60_000;
const LIMIT = 60;
const hits = new Map<string, { n: number; t: number }>();
const allowed = (ip: string) => {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now - e.t > WINDOW_MS) {
    hits.set(ip, { n: 1, t: now });
    return true;
  }
  return ++e.n <= LIMIT;
};

const app = new Elysia()
  .use(cors({ origin: /^(chrome|moz|safari-web)-extension:\/\// }))
  .onBeforeHandle(({ request, status, path }) => {
    if (path === "/api/health") return;
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    if (!allowed(ip)) return status(429, { error: "too many requests" });
  })
  .get("/api/health", () => ({ ok: true }))
  .get("/api/define", async ({ query, status }) => {
    const word = (query.word ?? "")
      .trim()
      .toLowerCase()
      .replace(/['’]s$/, "")
      .replace(/['’]$/, "");
    if (!word) return status(400, { error: "missing word" });
    if (!words) return status(503, { error: "db not ready" });

    const lookup = (w: string) =>
      words!.findOne({ $or: [{ search_key: w }, { word: w }] }, { projection: PROJECTION });

    const candidates = [word];
    if (word.endsWith("s") && word.length > 3) candidates.push(word.slice(0, -1));
    if (word.endsWith("ies")) candidates.push(word.slice(0, -3) + "y");
    if (word.includes("-")) candidates.push(word.split("-").pop()!);

    let doc = null;
    for (const c of candidates) {
      doc = await lookup(c);
      if (doc) break;
    }
    if (!doc) return status(404, { error: "not found" });

    return shapeWord(doc);
  })
  .get("/api/suggest", async ({ query }) => {
    const q = (query.q ?? "").trim().toLowerCase();
    if (!q || !words) return { suggestions: [] };
    const regex = new RegExp(`^${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    const docs = await words
      .find({ word: regex })
      .project({ word: 1, phonetic: 1, senses: 1 })
      .limit(8)
      .toArray();

    return {
      suggestions: docs.map((d) => ({
        word: d.word,
        phonetic: d.phonetic,
        meaning: d.senses?.[0] || "",
      })),
    };
  })
  .get("/api/random", async ({ status }) => {
    if (!words) return status(503, { error: "db not ready" });
    const [doc] = await words.aggregate([{ $sample: { size: 1 } }]).toArray();
    if (!doc) return status(404, { error: "no words found" });

    return shapeWord(doc);
  })
  .listen(2999);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
