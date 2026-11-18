---
name: bbm-skills-loader
description: Loads Brand Bridge Media / Living Cozy skills from GitHub for Cowork and claude.ai chat. Every real skill (webflow-cms, listicle-refresh, supabase-architecture, google-seo, jira-architecture, livingcozy-brand-voice, affiliate-hub, knowledge-system and ~55 more) lives in the brand-bridge-media/claude-skills repo and is read from there on demand. ALWAYS use before any Living Cozy, livingcozy.com, homesupply.co or Brand Bridge Media work — Webflow, CMS, articles, listicles, refreshes, products, brands, affiliates, links, Supabase, Cloudflare, Jira, Notion, analytics, SEO, newsletter, images, editorial voice — and whenever a request names a skill or says "per the skill", "check the skill", "which skill". Triggers on Living Cozy, BBM, Brand Bridge, skill, playbook, how do we, our process.
---

# BBM skills loader

The Living Cozy / BBM skill library is **not** installed here. It lives in GitHub and is read
on demand, so this one small skill never goes stale and nothing needs syncing.

- **Repo:** `brand-bridge-media/claude-skills`, branch `main`
- **A skill:** `living-cozy/skills/<name>/SKILL.md`
- **The map of which skill owns what:** `living-cozy/skills/skill-library-index/SKILL.md`

## How to use it

1. **Already loaded?** If the skill you need is already in your list of available skills
   (Claude Code sessions on a BBM repo load them from `.claude/skills/`), use that and stop here.
2. **Pick the skill.** If the owner is obvious from its name, go straight to step 3. If not,
   read `skill-library-index/SKILL.md` first; it maps every subject to the one skill that owns it.
3. **Read that skill's `SKILL.md`** from `main` with the GitHub connector (get file contents).
   Read all of it before acting; the rules are the point.
4. **Follow its pointers.** Open a `references/` or `scripts/` file only when the SKILL.md
   tells you to, so you only spend context on what this task needs.
5. **Work from what you read, not from memory.** If the connector is unavailable or the
   read fails, say so plainly and stop short of anything that skill governs. Never guess
   field names, IDs or rules a skill would have given you.

## Rules

- **Read-only here.** Never edit a skill from Cowork or chat, and never `save_skill` a copy of
  one into the claude.ai library: a saved copy goes stale and loads beside the real one. A skill
  change is a PR to `claude-skills` (best done in Claude Code); merging it is the deploy.
- **`main` is the truth.** Do not read skills from other branches or from a repo's
  `.claude/skills/` mirror; those are copies of `main`.
- **Cite what you used.** When a skill shaped the answer, name it (e.g. "per `webflow-cms`").

## Where this file lives (LC-2227)

This skill ships as the `bbm-skills-loader` plugin in the `bbm-mods` marketplace. Its one source
is `claude-mods/bbm-skills-loader/skills/bbm-skills-loader/SKILL.md` in bbm-infrastructure; the
mirror publishes it to `brand-bridge-media/bbm-mods`. Nothing is uploaded to claude.ai by hand.
After a change merges, the operator runs claude.ai Plugins > Add > Manage marketplaces > bbm-mods
`...` > Check for updates.
