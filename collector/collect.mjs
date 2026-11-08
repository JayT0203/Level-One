// Level One job collector
// Pulls entry-level and junior games jobs from Adzuna and from studio job boards,
// keeps only junior roles, and writes them to jobs.json for the website.
// Runs on GitHub Actions. Needs Node 20 or newer. No extra packages required.

import { readFile, writeFile } from "node:fs/promises";

const APP_ID = process.env.ADZUNA_APP_ID;
const APP_KEY = process.env.ADZUNA_APP_KEY;
const MAX_DAYS_OLD = 30;

// ---------- Rules for deciding what counts as a junior games job ----------

const JUNIOR = /\b(junior|jr\.?|graduate|grad|entry[- ]level|trainee|intern|internship|apprentice|apprenticeship|associate|placement|year in industry)\b/i;
const QA_ENTRY = /\b(qa|quality assurance|game|games|localisation|localization|compliance)\s+(tester|testing)\b|\btester\b/i;
const SENIOR = /\b(senior|snr|sr\.?|lead|principal|director|head of|staff|vp|chief|expert|architect)\b/i;
const GAMES = /\b(game|games|gaming|video ?game|unreal|unity|playstation|xbox|nintendo|console)\b/i;
const GAMBLING = /\b(casino|betting|gambling|igaming|i-gaming|slots?|bingo|lottery|sportsbook|wagering)\b/i;

function levelOf(title) {
  const t = title.toLowerCase();
  if (/\bintern(ship)?\b|placement|year in industry/.test(t)) return "Intern";
  if (/\bgrad(uate)?\b/.test(t)) return "Graduate";
  if (/\btrainee\b|apprentice/.test(t)) return "Trainee";
  return "Junior";
}

function isJunior(title) {
  if (SENIOR.test(title)) return false;
  return JUNIOR.test(title) || QA_ENTRY.test(title);
}

function isGames(title, description, company = "") {
  const text = `${title} ${description} ${company}`;
  if (GAMBLING.test(text)) return false;
  return GAMES.test(text);
}

const DISCIPLINES = [
  ["QA", /\b(qa|quality assurance|tester|testing|localisation|localization)\b/i],
  ["Audio", /\b(audio|sound|music|composer|foley)\b/i],
  ["Animation", /\b(animator|animation)\b/i],
  ["Art", /\b(artist|art|3d|2d|concept|vfx|environment|character|ui artist|technical artist|illustrat)/i],
  ["Design", /\b(designer|design|narrative|writer|level)\b/i],
  ["Production", /\b(producer|production|project|scrum|coordinator)\b/i],
  ["Community", /\b(community|social media|content|marketing|player support|customer)\b/i],
  ["Programming", /\b(programmer|developer|engineer|programming|software|coder|technical)\b/i],
];
function disciplineOf(title) {
  for (const [name, re] of DISCIPLINES) if (re.test(title)) return name;
  return "Other";
}

const REMOTE = /\b(remote|work from home|wfh|home[- ]based|anywhere)\b/i;

// ---------- Helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s = "") =>
  s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const snippet = (s) => { const c = clean(s); return c.length > 400 ? c.slice(0, 400).replace(/\s\S*$/, "") + "…" : c; };

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "LevelOneJobs/1.0", Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "LevelOneJobs/1.0" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function makeJob({ title, company, location, region, remote, salaryMin, salaryMax, posted, url, source, description }) {
  title = clean(title);
  return {
    id: (company + "-" + title + "-" + location).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 120),
    title,
    company: clean(company) || "Unknown studio",
    location: clean(location) || "United Kingdom",
    region: region || "",
    remote: Boolean(remote),
    level: levelOf(title),
    discipline: disciplineOf(title),
    salaryMin: salaryMin ? Math.round(salaryMin) : null,
    salaryMax: salaryMax ? Math.round(salaryMax) : null,
    posted: posted ? new Date(posted).toISOString() : new Date().toISOString(),
    url,
    source,
    description: snippet(description || ""),
  };
}

// ---------- Source 1: Adzuna (UK-wide search) ----------

const ADZUNA_SEARCHES = [
  "junior game", "junior games", "graduate game", "graduate games",
  "games intern", "game internship", "games trainee", "games apprentice",
  "entry level game", "associate game", "game tester", "games tester", "qa tester games",
  "junior unity developer", "junior unreal", "junior game artist", "junior game designer",
];

async function fromAdzuna() {
  if (!APP_ID || !APP_KEY) {
    console.log("Adzuna: skipped (ADZUNA_APP_ID / ADZUNA_APP_KEY not set)");
    return [];
  }
  const jobs = [];
  for (const what of ADZUNA_SEARCHES) {
    const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${encodeURIComponent(APP_ID)}&app_key=${encodeURIComponent(APP_KEY)}`
      + `&results_per_page=50&max_days_old=${MAX_DAYS_OLD}&what=${encodeURIComponent(what)}&content-type=application/json`;
    try {
      const data = await getJSON(url);
      let kept = 0;
      for (const r of data.results || []) {
        const title = r.title || "", desc = r.description || "", company = r.company?.display_name || "";
        if (!isJunior(clean(title)) || !isGames(clean(title), clean(desc), company)) continue;
        const area = r.location?.area || [];
        jobs.push(makeJob({
          title, company,
          location: r.location?.display_name,
          region: area[1] || "",
          remote: REMOTE.test(`${title} ${desc} ${r.location?.display_name || ""}`),
          salaryMin: r.salary_is_predicted === "1" ? null : r.salary_min,
          salaryMax: r.salary_is_predicted === "1" ? null : r.salary_max,
          posted: r.created, url: r.redirect_url, source: "Adzuna", description: desc,
        }));
        kept++;
      }
      console.log(`Adzuna "${what}": ${data.results?.length || 0} results, kept ${kept}`);
    } catch (e) {
      console.log(`Adzuna "${what}": failed (${e.message})`);
    }
    await sleep(1500); // stay well inside Adzuna's rate limits
  }
  return jobs;
}

// ---------- Source 2: studio job boards listed in studios.json ----------

async function fromStudio(s) {
  const out = [];
  const push = (title, location, url, posted, description = "", remoteHint = "") => {
    if (!isJunior(clean(title))) return;
    out.push(makeJob({
      title, company: s.name, location: location || s.location, region: s.region,
      remote: s.remote === true || REMOTE.test(`${title} ${location || ""} ${remoteHint}`),
      posted, url, source: `${s.name} careers`, description,
    }));
  };

  if (s.type === "greenhouse") {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${s.board}/jobs?content=true`);
    for (const j of d.jobs || []) push(j.title, j.location?.name, j.absolute_url, j.updated_at, j.content);
  } else if (s.type === "lever") {
    const d = await getJSON(`https://api.lever.co/v0/postings/${s.board}?mode=json`);
    for (const j of d) push(j.text, j.categories?.location, j.hostedUrl, j.createdAt, j.descriptionPlain, j.workplaceType);
  } else if (s.type === "ashby") {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${s.board}`);
    for (const j of d.jobs || []) push(j.title, j.location, j.jobUrl, j.publishedAt, j.descriptionPlain, j.isRemote ? "remote" : "");
  } else if (s.type === "teamtailor") {
    const xml = await getText(s.feed);
    for (const item of xml.split("<item>").slice(1)) {
      const tag = (name) => (item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || "";
      const cdata = (v) => v.replace(/^<!\[CDATA\[|\]\]>$/g, "");
      const city = (item.match(/<tt:city>([\s\S]*?)<\/tt:city>/) || [])[1];
      push(cdata(tag("title")), city ? cdata(city) : s.location, cdata(tag("link")).trim(), tag("pubDate"), cdata(tag("description")));
    }
  } else {
    throw new Error(`unknown type "${s.type}"`);
  }
  return out;
}

async function fromStudios() {
  const studios = JSON.parse(await readFile(new URL("../studios.json", import.meta.url), "utf8"));
  const jobs = [];
  for (const s of studios) {
    try {
      const found = await fromStudio(s);
      console.log(`${s.name}: kept ${found.length} junior roles`);
      jobs.push(...found);
    } catch (e) {
      console.log(`${s.name}: failed (${e.message})`);
    }
  }
  return jobs;
}

// ---------- Put it all together ----------

const all = [...(await fromStudios()), ...(await fromAdzuna())];

// Studio boards come first, so if Adzuna has the same job, the studio's own link wins.
const seen = new Set();
const jobs = [];
for (const j of all) {
  const key = (j.company + "|" + j.title).toLowerCase().replace(/[^a-z0-9|]/g, "");
  if (seen.has(key)) continue;
  seen.add(key);
  jobs.push(j);
}
jobs.sort((a, b) => b.posted.localeCompare(a.posted));

// If every source failed, keep yesterday's file rather than wiping the site.
const outFile = new URL("../jobs.json", import.meta.url);
if (jobs.length === 0) {
  try {
    const old = JSON.parse(await readFile(outFile, "utf8"));
    if (old.jobs?.length) { console.log("No jobs found this run, keeping the previous list."); process.exit(0); }
  } catch {}
}

await writeFile(outFile, JSON.stringify({ updated: new Date().toISOString(), count: jobs.length, jobs }, null, 2) + "\n");
console.log(`Saved ${jobs.length} jobs to jobs.json`);
