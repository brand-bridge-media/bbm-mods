# bbm-mods

Read-only public mirror of the Claude Code mods (plugins) that Brand Bridge Media
sessions run. The source of truth is `claude-mods/` in the private
`bbm-infrastructure` repo; every merge there that touches a mod overwrites this repo
with a fresh snapshot. Edits made here are lost on the next sync.

**Pull requests are not accepted.** One opened by anyone but the owner is closed
automatically and the owner is notified.

Install (what the cloud environment setup script runs):

```
claude plugin marketplace add brand-bridge-media/bbm-mods
claude plugin install fleet-tracker@bbm-mods --scope user
```
