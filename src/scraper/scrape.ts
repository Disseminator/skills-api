/**
 * Skills.sh Scraper
 * Extracts skills data from the skills.sh website
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ScrapedSkill {
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

export interface EnrichedSkill extends ScrapedSkill {
  /** GitHub owner */
  owner: string;
  /** GitHub repo */
  repo: string;
  /** Full GitHub URL */
  githubUrl: string;
  /** Display name (formatted from name) */
  displayName: string;
}

interface AllTimeSkillsPage {
  skills: ScrapedSkill[];
  total: number | null;
  hasMore: boolean | null;
  page: number | null;
}

const SKILLS_BASE_URL = 'https://skills.sh';
const ALL_TIME_API_BASE = `${SKILLS_BASE_URL}/api/skills/all-time`;
const MAX_ALL_TIME_PAGES = 1000;
const API_PAGE_CONCURRENCY = 8;

/**
 * Scrape skills from skills.sh
 */
export async function scrapeSkills(): Promise<ScrapedSkill[]> {
  try {
    return await scrapeSkillsFromAllTimeApi();
  } catch (apiError) {
    const message = apiError instanceof Error ? apiError.message : String(apiError);
    console.warn(`[Scraper] All-time API scrape failed, falling back to page parse: ${message}`);
    return scrapeSkillsFromPage();
  }
}

async function scrapeSkillsFromAllTimeApi(): Promise<ScrapedSkill[]> {
  const firstPage = await fetchAllTimeSkillsPage(0);
  if (firstPage.skills.length === 0) {
    throw new Error('All-time API returned no skills on page 0');
  }

  const allSkills = [...firstPage.skills];
  const totalPages = getTotalPages(firstPage);

  if (totalPages !== null) {
    if (totalPages > MAX_ALL_TIME_PAGES) {
      throw new Error(`All-time API requires ${totalPages} pages, exceeding max ${MAX_ALL_TIME_PAGES}`);
    }

    const remainingPages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => index + 1);
    for (let i = 0; i < remainingPages.length; i += API_PAGE_CONCURRENCY) {
      const batch = remainingPages.slice(i, i + API_PAGE_CONCURRENCY);
      const pageResults = await Promise.all(batch.map(page => fetchAllTimeSkillsPage(page)));
      for (const result of pageResults) {
        allSkills.push(...result.skills);
      }
    }

    return dedupeSkills(allSkills);
  }

  // Fallback path if total is missing: follow hasMore until exhaustion.
  let page = 1;
  let hasMore = firstPage.hasMore ?? true;
  while (hasMore) {
    if (page >= MAX_ALL_TIME_PAGES) {
      throw new Error(`All-time API pagination exceeded ${MAX_ALL_TIME_PAGES} pages`);
    }

    const nextPage = await fetchAllTimeSkillsPage(page);
    if (nextPage.skills.length === 0) {
      break;
    }

    allSkills.push(...nextPage.skills);
    hasMore = nextPage.hasMore ?? false;
    page += 1;
  }

  return dedupeSkills(allSkills);
}

async function scrapeSkillsFromPage(): Promise<ScrapedSkill[]> {
  const response = await fetch(SKILLS_BASE_URL);
  if (!response.ok) {
    throw new Error(`Failed to load skills.sh page (${response.status})`);
  }

  const html = await response.text();
  return extractSkillsFromPageHtml(html);
}

async function fetchAllTimeSkillsPage(page: number): Promise<AllTimeSkillsPage> {
  const response = await fetch(`${ALL_TIME_API_BASE}/${page}`);
  if (!response.ok) {
    throw new Error(`All-time API request failed for page ${page} (${response.status})`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const skills = toScrapedSkills(payload.skills);
  const total = typeof payload.total === 'number' ? payload.total : null;
  const hasMore = typeof payload.hasMore === 'boolean' ? payload.hasMore : null;
  const pageFromPayload = typeof payload.page === 'number' ? payload.page : null;

  return {
    skills,
    total,
    hasMore,
    page: pageFromPayload,
  };
}

function getTotalPages(page: AllTimeSkillsPage): number | null {
  if (page.total === null || page.total <= 0) {
    return null;
  }

  const pageSize = page.skills.length;
  if (pageSize <= 0) {
    return null;
  }

  return Math.ceil(page.total / pageSize);
}

function extractSkillsFromPageHtml(html: string): ScrapedSkill[] {
  for (const key of ['allTimeSkills', 'initialSkills']) {
    const parsed = tryExtractEscapedArrayByKey(html, key);
    if (parsed !== null) {
      return parsed;
    }
  }

  throw new Error('Could not find allTimeSkills or initialSkills in page');
}

function tryExtractEscapedArrayByKey(html: string, key: string): ScrapedSkill[] | null {
  const escapedKey = escapeRegExp(key);
  const candidates = [
    {
      regex: new RegExp(`${escapedKey}\\\\":\\[([\\s\\S]*?)\\]`),
      unescape: true,
    },
    {
      regex: new RegExp(`"${escapedKey}":\\[([\\s\\S]*?)\\]`),
      unescape: false,
    },
  ];

  for (const candidate of candidates) {
    const match = html.match(candidate.regex);
    if (!match) {
      continue;
    }

    let jsonStr = `[${match[1]}]`;
    if (candidate.unescape) {
      jsonStr = jsonStr.replace(/\\"/g, '"');
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return toScrapedSkills(parsed);
    } catch {
      continue;
    }
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toScrapedSkills(value: unknown): ScrapedSkill[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected skills to be an array');
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid skill at index ${index}: expected object`);
    }

    const source = (entry as { source?: unknown }).source;
    const skillId = (entry as { skillId?: unknown }).skillId;
    const name = (entry as { name?: unknown }).name;
    const installsRaw = (entry as { installs?: unknown }).installs;
    const installs =
      typeof installsRaw === 'number'
        ? installsRaw
        : typeof installsRaw === 'string'
          ? Number.parseInt(installsRaw, 10)
          : Number.NaN;

    if (
      typeof source !== 'string' ||
      typeof skillId !== 'string' ||
      typeof name !== 'string' ||
      !Number.isFinite(installs)
    ) {
      throw new Error(`Invalid skill at index ${index}: malformed fields`);
    }

    return {
      source,
      skillId,
      name,
      installs,
    };
  });
}

function dedupeSkills(skills: ScrapedSkill[]): ScrapedSkill[] {
  const deduped = new Map<string, ScrapedSkill>();
  for (const skill of skills) {
    deduped.set(`${skill.source}::${skill.skillId}`, skill);
  }

  return Array.from(deduped.values());
}

/**
 * Enrich skills with additional computed fields
 */
export function enrichSkills(skills: ScrapedSkill[]): EnrichedSkill[] {
  return skills.map(skill => {
    const parts = skill.source.split('/');
    const owner = parts[0] ?? '';
    const repo = parts[1] ?? '';
    return {
      ...skill,
      owner,
      repo,
      githubUrl: `https://github.com/${skill.source}`,
      displayName: formatDisplayName(skill.name),
    };
  });
}

/**
 * Format skill name as display name
 */
function formatDisplayName(name: string): string {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Get unique sources (repositories) from skills
 */
export function getUniqueSources(skills: ScrapedSkill[]): string[] {
  const sources = new Set<string>();
  for (const skill of skills) {
    sources.add(skill.source);
  }
  return Array.from(sources).sort();
}

/**
 * Get unique owners from skills
 */
export function getUniqueOwners(skills: ScrapedSkill[]): string[] {
  const owners = new Set<string>();
  for (const skill of skills) {
    const owner = skill.source.split('/')[0];
    if (owner) {
      owners.add(owner);
    }
  }
  return Array.from(owners).sort();
}

/**
 * Main scraper function - scrapes and saves to JSON file
 */
export async function scrapeAndSave(outputPath?: string): Promise<void> {
  console.info('Scraping skills from skills.sh...');

  const scrapedSkills = await scrapeSkills();
  console.info(`Found ${scrapedSkills.length} skills`);

  const enriched = enrichSkills(scrapedSkills);

  const output = {
    scrapedAt: new Date().toISOString(),
    totalSkills: enriched.length,
    totalSources: getUniqueSources(scrapedSkills).length,
    totalOwners: getUniqueOwners(scrapedSkills).length,
    skills: enriched,
  };

  const defaultPath = join(__dirname, '..', 'registry', 'scraped-skills.json');
  const filePath = outputPath ?? defaultPath;
  writeFileSync(filePath, JSON.stringify(output, null, 2));
  console.info(`Saved to ${filePath}`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeAndSave().catch(console.error);
}
