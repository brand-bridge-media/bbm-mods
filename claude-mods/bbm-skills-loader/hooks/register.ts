import type { Register } from 'claude-code'

// Why (LC-2227): this plugin exists to carry one skill (skills/bbm-skills-loader) through the bbm-mods
// marketplace, so it reaches claude.ai chat, Cowork and project threads without a hand upload. It reacts
// to nothing. This empty module is here only because `claude plugin test`, which claude-mods.yml runs on
// every mod, refuses a plugin with no hooks module. It registers no handler, so it costs nothing at rest.
export const register: Register = () => {}
